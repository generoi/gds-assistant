<?php

namespace GeneroWP\Assistant\Llm;

use GeneroWP\Assistant\Bridge\AbilitiesToolProvider;
use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Storage\AuditLog;
use Illuminate\Support\Facades\Log;

class MessageLoop
{
    private int $inputTokens = 0;

    private int $outputTokens = 0;

    private string $updatedSummary = '';

    public function __construct(
        private readonly LlmProviderInterface $provider,
        private readonly ToolRegistry $toolRegistry,
        private readonly ?AuditLog $auditLog = null,
        private readonly string $conversationUuid = '',
        private readonly int $userId = 0,
        private readonly string $existingSummary = '',
    ) {}

    public function getInputTokens(): int
    {
        return $this->inputTokens;
    }

    public function getOutputTokens(): int
    {
        return $this->outputTokens;
    }

    public function getUpdatedSummary(): string
    {
        return $this->updatedSummary;
    }

    /**
     * Run the agentic loop: stream LLM response, execute tool calls, repeat.
     *
     * @param  array  $messages  Conversation messages
     * @param  callable  $onEvent  SSE event callback: fn(string $type, array $data)
     * @param  string|null  $systemPrompt  System prompt
     * @return array Updated messages array (including assistant + tool results)
     */
    public function run(
        array $messages,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        $maxIterations = apply_filters('gds-assistant/max_iterations', 25);
        $tools = $this->toolRegistry->getAllTools();
        $tools = apply_filters('gds-assistant/tools', $tools);

        // Track token usage across iterations
        $wrappedOnEvent = function (string $type, array $data) use ($onEvent) {
            if ($type === 'usage') {
                $this->inputTokens += $data['input_tokens'] ?? 0;
                $this->outputTokens += $data['output_tokens'] ?? 0;
            }
            $onEvent($type, $data);
        };

        for ($i = 0; $i < $maxIterations; $i++) {
            // Compress context if conversation is getting long
            $tokensBefore = ContextCompressor::estimateTokens($messages);
            $compressed = ContextCompressor::compress($messages, $this->existingSummary);
            $messagesForLlm = $compressed['messages'];
            $tokensAfter = ContextCompressor::estimateTokens($messagesForLlm);
            if (! empty($compressed['summary'])) {
                $this->updatedSummary = $compressed['summary'];
            }
            if ($tokensAfter < $tokensBefore) {
                $onEvent('text_delta', ['text' => "\n_Context compressed: {$tokensBefore} → {$tokensAfter} tokens_\n"]);
            }

            $contentBlocks = $this->provider->stream(
                $messagesForLlm,
                $tools,
                $wrappedOnEvent,
                $systemPrompt,
            );

            // Add assistant message to conversation
            $assistantMessage = [
                'role' => 'assistant',
                'content' => array_values($contentBlocks),
            ];
            $messages[] = $assistantMessage;

            // Check for tool use blocks
            $toolUseBlocks = array_filter(
                $contentBlocks,
                fn ($block) => ($block['type'] ?? '') === 'tool_use',
            );

            if (empty($toolUseBlocks)) {
                break;
            }

            // Execute each tool and collect results
            $toolResults = [];
            $pendingApproval = false;

            foreach ($toolUseBlocks as $toolUse) {
                $toolInput = json_decode(json_encode($toolUse['input'] ?? []), true) ?: [];
                $abilityName = AbilitiesToolProvider::toAbilityName($toolUse['name']);
                $isDestructive = $this->isDestructive($abilityName);

                // Check if this tool requires user approval (dangerous tools)
                $toolDef = ['name' => $toolUse['name'], 'description' => ''];
                foreach ($tools as $t) {
                    if (($t['name'] ?? '') === $toolUse['name']) {
                        $toolDef = $t;
                        break;
                    }
                }
                $riskLevel = ToolRestrictor::classifyRisk($toolDef);

                if ($riskLevel === 'dangerous' || ($riskLevel === 'moderate' && $isDestructive)) {
                    $onEvent('tool_approval_required', [
                        'tool_use_id' => $toolUse['id'],
                        'tool_name' => $abilityName,
                        'input' => $toolInput,
                    ]);

                    $toolResults[] = [
                        'type' => 'tool_result',
                        'tool_use_id' => $toolUse['id'],
                        'content' => json_encode(['status' => 'pending_approval', 'tool_name' => $abilityName]),
                        'is_error' => false,
                    ];
                    $pendingApproval = true;

                    break; // Stop processing more tools, wait for user
                }

                // Log the actual parsed input
                if (class_exists(Log::class)) {
                    try {
                        Log::info("[gds-assistant] Tool execute: {$abilityName}", [
                            'conversation' => $this->conversationUuid,
                            'input' => $toolInput,
                        ]);
                    } catch (\Throwable) {
                    }
                }

                $result = $this->toolRegistry->executeTool(
                    $toolUse['name'],
                    $toolInput,
                );

                $isError = is_wp_error($result);
                $resultContent = $isError
                    ? ['error' => $result->get_error_message()]
                    : $result;

                // Audit log
                if ($this->auditLog) {
                    $this->auditLog->log(
                        $this->conversationUuid,
                        $this->userId,
                        $abilityName,
                        $toolInput,
                        $result,
                        $isError,
                        $isDestructive,
                    );
                }

                $onEvent('tool_result', [
                    'tool_use_id' => $toolUse['id'],
                    'result' => $resultContent,
                    'is_error' => $isError,
                ]);

                // Truncate large results to avoid exceeding context limits.
                $resultJson = json_encode($resultContent);
                $maxResultSize = 20000; // ~5K tokens
                if (strlen($resultJson) > $maxResultSize) {
                    $resultJson = substr($resultJson, 0, $maxResultSize)
                        .'... [truncated, '
                        .strlen($resultJson).' bytes total]';
                }

                $toolResults[] = [
                    'type' => 'tool_result',
                    'tool_use_id' => $toolUse['id'],
                    'content' => $resultJson,
                    'is_error' => $isError,
                ];
            }

            // Add tool results as a user message
            $messages[] = ['role' => 'user', 'content' => $toolResults];

            // If a tool requires approval, break the loop and let the user decide
            if ($pendingApproval) {
                break;
            }
        }

        return $messages;
    }

    private function isDestructive(string $abilityName): bool
    {
        if (! function_exists('wp_get_ability')) {
            return false;
        }

        $ability = wp_get_ability($abilityName);
        if (! $ability) {
            return false;
        }

        $meta = $ability->get_meta();

        return ! empty($meta['annotations']['destructive']);
    }
}
