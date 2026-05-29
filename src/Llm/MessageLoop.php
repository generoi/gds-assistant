<?php

namespace GeneroWP\Assistant\Llm;

use GeneroWP\Assistant\Bridge\AbilitiesToolProvider;
use GeneroWP\Assistant\Bridge\EditorToolProvider;
use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Storage\AuditLog;
use Illuminate\Support\Facades\Log;

class MessageLoop
{
    private int $inputTokens = 0;

    private int $cacheCreationTokens = 0;

    private int $cacheReadTokens = 0;

    private int $outputTokens = 0;

    public function getCacheCreationTokens(): int
    {
        return $this->cacheCreationTokens;
    }

    public function getCacheReadTokens(): int
    {
        return $this->cacheReadTokens;
    }

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
     * @param  array<int, array<string, mixed>>  $messages  Conversation messages
     * @param  callable(string, array<string, mixed>): void  $onEvent  SSE event callback
     * @param  string|null  $systemPrompt  System prompt
     * @return array<int, array<string, mixed>> Updated messages array (including assistant + tool results)
     */
    public function run(
        array $messages,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        $maxIterations = apply_filters('gds-assistant/max_iterations', 25);
        $tools = $this->toolRegistry->getAllTools();
        $tools = apply_filters('gds-assistant/tools', $tools);

        // Track token usage across iterations. All providers now emit
        // unified field names: cache_read_tokens / cache_write_tokens.
        // Explicit (int) casts: a provider that ever emits a string ("1024")
        // instead of an int would silently accumulate to 0 with the bare
        // `+= ($data[...] ?? 0)`, breaking budget tracking. Cast at the
        // boundary so accounting matches the type the rest of the loop
        // expects.
        $wrappedOnEvent = function (string $type, array $data) use ($onEvent) {
            if ($type === 'usage') {
                $this->inputTokens += (int) ($data['input_tokens'] ?? 0);
                $this->outputTokens += (int) ($data['output_tokens'] ?? 0);
                $this->cacheCreationTokens += (int) ($data['cache_write_tokens'] ?? 0);
                $this->cacheReadTokens += (int) ($data['cache_read_tokens'] ?? 0);
            }
            $onEvent($type, $data);
        };

        for ($i = 0; $i < $maxIterations; $i++) {
            // Compress context if conversation is getting long
            $tokensBefore = ContextCompressor::estimateTokens($messages);
            $compressed = ContextCompressor::compress($messages, $this->existingSummary);
            // Providers only accept {role, content}; drop display metadata we
            // carry on stored messages (e.g. per-message `ts` timestamps).
            $messagesForLlm = self::stripMessageMeta($compressed['messages']);
            $tokensAfter = ContextCompressor::estimateTokens($messagesForLlm);
            if (! empty($compressed['summary'])) {
                $this->updatedSummary = $compressed['summary'];
            }
            // Log compression for debugging but don't show to user — once
            // a conversation is long enough, compression fires every turn
            // and the notices clutter the chat.
            if ($tokensBefore !== $tokensAfter) {
                error_log("[gds-assistant] Context compressed: {$tokensBefore} → {$tokensAfter} tokens");
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

            // Execute each tool and collect results.
            //
            // IMPORTANT: we must emit a tool_result for EVERY tool_use in the
            // assistant message, otherwise Anthropic (and other providers)
            // reject the next API call with "tool_use ids were found without
            // tool_result blocks". So when a dangerous tool needs approval we
            // still iterate the rest — if they're also dangerous they get
            // their own pending-approval stubs, if they're safe they execute
            // normally. The outer loop breaks at the end only when at least
            // one approval was requested.
            $toolResults = [];
            $pendingApproval = false;
            $pendingClient = false;

            foreach ($toolUseBlocks as $toolUse) {
                $toolInput = json_decode(json_encode($toolUse['input'] ?? []), true) ?: [];

                // Client-executed editor tools: the server can't touch the open
                // editor, so stream a client_tool_call, stub the result, and
                // break — the browser runs the op against @wordpress/data and
                // POSTs the result back (same round-trip as human approval).
                if (EditorToolProvider::isClientTool($toolUse['name'])) {
                    $onEvent('client_tool_call', [
                        'tool_use_id' => $toolUse['id'],
                        'tool_name' => $toolUse['name'],
                        'input' => $toolInput,
                    ]);
                    $toolResults[] = [
                        'type' => 'tool_result',
                        'tool_use_id' => $toolUse['id'],
                        'content' => json_encode(['status' => 'pending_client', 'tool_name' => $toolUse['name']]),
                        'is_error' => false,
                    ];
                    $pendingClient = true;

                    continue;
                }

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

                $needsApproval = $riskLevel === 'dangerous' || ($riskLevel === 'moderate' && $isDestructive);

                // Per-invocation override: abilities can declare themselves
                // destructive statically but exempt specific inputs dynamically
                // (e.g. web-fetch auto-approves trusted hosts).
                $needsApproval = apply_filters(
                    'gds-assistant/tool_requires_approval',
                    $needsApproval,
                    $abilityName,
                    $toolInput,
                );

                if ($needsApproval) {
                    // If tool input contains a URL, surface its host so the
                    // UI can offer an "Approve & trust domain" option.
                    $trustableHost = null;
                    if (! empty($toolInput['url'])) {
                        $trustableHost = wp_parse_url((string) $toolInput['url'], PHP_URL_HOST) ?: null;
                    }

                    $onEvent('tool_approval_required', [
                        'tool_use_id' => $toolUse['id'],
                        'tool_name' => $abilityName,
                        'input' => $toolInput,
                        'trustable_host' => $trustableHost,
                    ]);

                    $toolResults[] = [
                        'type' => 'tool_result',
                        'tool_use_id' => $toolUse['id'],
                        'content' => json_encode(['status' => 'pending_approval', 'tool_name' => $abilityName]),
                        'is_error' => false,
                    ];
                    $pendingApproval = true;

                    continue; // Keep iterating so every tool_use gets a paired tool_result
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

                // Peel off the `_undo` snapshot an ability may attach: it's
                // stored on the audit row for later restore, but must NOT reach
                // the LLM, the SSE stream, or the saved conversation (it can be
                // large and is internal-only).
                $undoState = null;
                if (! $isError && is_array($result) && isset($result['_undo'])) {
                    $undoState = $result['_undo'];
                    unset($result['_undo']);
                }

                $resultContent = $isError
                    ? ['error' => $result->get_error_message()]
                    : $result;

                // Audit log
                $logged = ['id' => 0, 'undoable' => false];
                if ($this->auditLog) {
                    $logged = $this->auditLog->log(
                        $this->conversationUuid,
                        $this->userId,
                        $abilityName,
                        $toolInput,
                        $result,
                        $isError,
                        $isDestructive,
                        $undoState,
                    );
                }

                $resultEvent = [
                    'tool_use_id' => $toolUse['id'],
                    'result' => $resultContent,
                    'is_error' => $isError,
                ];
                // Tell the UI this action can be undone (drives the Undo button).
                if ($logged['undoable'] && $logged['id']) {
                    $resultEvent['undoable'] = true;
                    $resultEvent['audit_id'] = $logged['id'];
                    $resultEvent['undo_label'] = $undoState['label'] ?? 'Undo this action';
                }
                $onEvent('tool_result', $resultEvent);

                // Keep the full result — ContextCompressor handles
                // oversized tool results with structure-aware summarization
                // (see ContextCompressor::summarizeToolResult). The previous
                // blunt substring truncation at 20k chars produced INVALID
                // JSON, which made Gemini's functionResponse decode fail
                // and the LLM report "error retrieving the list".
                $toolResults[] = [
                    'type' => 'tool_result',
                    'tool_use_id' => $toolUse['id'],
                    'content' => json_encode($resultContent),
                    'is_error' => $isError,
                ];
            }

            // Add tool results as a user message
            $messages[] = ['role' => 'user', 'content' => $toolResults];

            // Break to hand control back: either the user must approve a
            // dangerous tool, or the browser must execute a client tool and
            // POST its result. Both resume on the next request.
            if ($pendingApproval || $pendingClient) {
                break;
            }
        }

        return $messages;
    }

    /**
     * Reduce messages to the {role, content} pair the providers accept, dropping
     * any display/storage metadata (e.g. per-message `ts`). Applied only to the
     * provider-bound copy — the returned/persisted transcript keeps its extras.
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @return array<int, array{role: string, content: mixed}>
     */
    private static function stripMessageMeta(array $messages): array
    {
        return array_map(
            fn ($m) => ['role' => $m['role'] ?? 'user', 'content' => $m['content'] ?? ''],
            $messages,
        );
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
