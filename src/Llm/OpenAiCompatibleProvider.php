<?php

namespace GeneroWP\Assistant\Llm;

/**
 * OpenAI-compatible provider. Works with OpenAI, Mistral, Groq, xAI, DeepSeek.
 * All use the same API format — just different base URLs and API keys.
 */
class OpenAiCompatibleProvider implements LlmProviderInterface
{
    public function __construct(
        private readonly string $apiKey,
        private readonly string $model,
        private readonly int $maxTokens = 4096,
        private readonly string $baseUrl = 'https://api.openai.com/v1',
        private readonly string $providerName = 'openai',
    ) {}

    public function name(): string
    {
        return $this->providerName;
    }

    public function stream(
        array $messages,
        array $tools,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        // Convert messages to OpenAI format
        $oaiMessages = [];

        if ($systemPrompt) {
            $oaiMessages[] = ['role' => 'system', 'content' => $systemPrompt];
        }

        foreach ($messages as $msg) {
            $oaiMessages[] = self::convertMessage($msg);
        }

        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'stream' => true,
            'messages' => $oaiMessages,
        ];

        if (! empty($tools)) {
            $payload['tools'] = self::convertTools($tools);
        }

        // Request usage stats in streaming mode (OpenAI-specific, ignored by others)
        $payload['stream_options'] = ['include_usage' => true];

        $contentBlocks = [];
        $currentIndex = -1;
        $toolCallBuffers = []; // id => {name, arguments_json}
        $errorBody = '';
        $lineBuffer = '';

        $ch = curl_init($this->baseUrl.'/chat/completions');

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer '.$this->apiKey,
            ],
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $data) use (
                &$lineBuffer,
                &$contentBlocks,
                &$currentIndex,
                &$toolCallBuffers,
                &$errorBody,
                $onEvent,
            ) {
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                if ($httpCode >= 400) {
                    $errorBody .= $data;

                    return strlen($data);
                }

                $lineBuffer .= $data;

                while (($pos = strpos($lineBuffer, "\n")) !== false) {
                    $line = trim(substr($lineBuffer, 0, $pos));
                    $lineBuffer = substr($lineBuffer, $pos + 1);

                    if ($line === '' || $line === 'data: [DONE]') {
                        continue;
                    }

                    if (! str_starts_with($line, 'data: ')) {
                        continue;
                    }

                    $json = substr($line, 6);
                    $event = json_decode($json, true);
                    if (! $event) {
                        continue;
                    }

                    $this->processChunk(
                        $event,
                        $contentBlocks,
                        $currentIndex,
                        $toolCallBuffers,
                        $onEvent,
                    );
                }

                return strlen($data);
            },
        ]);

        curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($curlError) {
            $onEvent('error', ['message' => 'curl error: '.$curlError]);
        }

        if ($httpCode >= 400) {
            $errorMsg = "API returned HTTP $httpCode";
            $decoded = json_decode($errorBody, true);
            if ($decoded && isset($decoded['error']['message'])) {
                $errorMsg .= ': '.$decoded['error']['message'];
            }
            $onEvent('error', ['message' => $errorMsg]);
        }

        return $contentBlocks;
    }

    private function processChunk(
        array $event,
        array &$contentBlocks,
        int &$currentIndex,
        array &$toolCallBuffers,
        callable $onEvent,
    ): void {
        $delta = $event['choices'][0]['delta'] ?? null;
        $finishReason = $event['choices'][0]['finish_reason'] ?? null;
        $usage = $event['usage'] ?? null;

        if ($delta) {
            // Text content
            if (isset($delta['content']) && $delta['content'] !== '') {
                if (! isset($contentBlocks[$currentIndex]) || ($contentBlocks[$currentIndex]['type'] ?? '') !== 'text') {
                    $currentIndex++;
                    $contentBlocks[$currentIndex] = ['type' => 'text', 'text' => ''];
                }
                $contentBlocks[$currentIndex]['text'] .= $delta['content'];
                $onEvent('text_delta', ['text' => $delta['content']]);
            }

            // Tool calls (streamed incrementally)
            if (! empty($delta['tool_calls'])) {
                foreach ($delta['tool_calls'] as $tc) {
                    $tcIndex = $tc['index'] ?? 0;

                    if (isset($tc['id'])) {
                        // New tool call starting
                        $toolCallBuffers[$tcIndex] = [
                            'id' => $tc['id'],
                            'name' => $tc['function']['name'] ?? '',
                            'arguments' => '',
                        ];

                        $currentIndex++;
                        $contentBlocks[$currentIndex] = [
                            'type' => 'tool_use',
                            'id' => $tc['id'],
                            'name' => $tc['function']['name'] ?? '',
                            'input' => new \stdClass,
                        ];

                        $onEvent('tool_use_start', [
                            'id' => $tc['id'],
                            'name' => $tc['function']['name'] ?? '',
                            'input' => new \stdClass,
                        ]);
                    }

                    if (isset($tc['function']['arguments'])) {
                        $toolCallBuffers[$tcIndex]['arguments'] .= $tc['function']['arguments'];
                    }
                }
            }
        }

        // Finish: parse tool call arguments
        if ($finishReason === 'tool_calls' || $finishReason === 'stop') {
            foreach ($toolCallBuffers as $tcIndex => $tc) {
                $parsed = json_decode($tc['arguments'], true);
                // Find the matching content block and update input
                foreach ($contentBlocks as &$block) {
                    if (($block['type'] ?? '') === 'tool_use' && ($block['id'] ?? '') === $tc['id']) {
                        $block['input'] = $parsed ?: new \stdClass;
                        break;
                    }
                }
            }
            $toolCallBuffers = [];

            if ($finishReason === 'stop') {
                $onEvent('message_stop', ['stop_reason' => 'end_turn']);
            }
        }

        if ($usage) {
            $onEvent('usage', [
                'input_tokens' => $usage['prompt_tokens'] ?? 0,
                'output_tokens' => $usage['completion_tokens'] ?? 0,
            ]);
        }
    }

    /**
     * Convert Anthropic-style tools to OpenAI format.
     */
    private static function convertTools(array $tools): array
    {
        return array_map(fn ($tool) => [
            'type' => 'function',
            'function' => [
                'name' => $tool['name'],
                'description' => $tool['description'] ?? '',
                'parameters' => $tool['input_schema'] ?? ['type' => 'object'],
            ],
        ], $tools);
    }

    /**
     * Convert a message to OpenAI format.
     * Handles Anthropic-style content blocks and tool results.
     */
    private static function convertMessage(array $msg): array
    {
        $role = $msg['role'] ?? 'user';
        $content = $msg['content'] ?? '';

        // Simple string content
        if (is_string($content)) {
            return ['role' => $role, 'content' => $content];
        }

        // Array of content blocks (Anthropic format)
        if (is_array($content)) {
            // Check for tool_result blocks (user role with tool results)
            $hasToolResults = false;
            foreach ($content as $block) {
                if (($block['type'] ?? '') === 'tool_result') {
                    $hasToolResults = true;
                    break;
                }
            }

            if ($hasToolResults) {
                // Convert to OpenAI's tool message format (one message per result)
                // Return the first one — MessageLoop sends them individually
                foreach ($content as $block) {
                    if (($block['type'] ?? '') === 'tool_result') {
                        return [
                            'role' => 'tool',
                            'tool_call_id' => $block['tool_use_id'] ?? '',
                            'content' => is_string($block['content'] ?? null)
                                ? $block['content']
                                : json_encode($block['content'] ?? ''),
                        ];
                    }
                }
            }

            // Check for tool_use blocks (assistant role)
            $toolCalls = [];
            $textParts = [];
            foreach ($content as $block) {
                if (($block['type'] ?? '') === 'tool_use') {
                    $toolCalls[] = [
                        'id' => $block['id'] ?? '',
                        'type' => 'function',
                        'function' => [
                            'name' => $block['name'] ?? '',
                            'arguments' => json_encode($block['input'] ?? new \stdClass),
                        ],
                    ];
                } elseif (($block['type'] ?? '') === 'text') {
                    $textParts[] = $block['text'] ?? '';
                }
            }

            if ($toolCalls) {
                $msg = [
                    'role' => 'assistant',
                    'content' => implode('', $textParts) ?: null,
                    'tool_calls' => $toolCalls,
                ];

                return array_filter($msg, fn ($v) => $v !== null);
            }

            // Plain text blocks
            $text = implode('', array_map(fn ($b) => $b['text'] ?? '', $content));

            return ['role' => $role, 'content' => $text];
        }

        return ['role' => $role, 'content' => (string) $content];
    }
}
