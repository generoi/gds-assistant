<?php

namespace GeneroWP\Assistant\Llm;

/**
 * Google Gemini provider. Uses the generateContent API with function calling.
 * Unique format (functionDeclarations, not OpenAI-style tools).
 */
class GeminiProvider implements LlmProviderInterface
{
    private const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

    public function __construct(
        private readonly string $apiKey,
        private readonly string $model = 'gemini-2.5-flash-preview-05-20',
        private readonly int $maxTokens = 4096,
    ) {}

    public function name(): string
    {
        return 'gemini';
    }

    public function stream(
        array $messages,
        array $tools,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        $url = self::API_BASE."/{$this->model}:streamGenerateContent?alt=sse&key={$this->apiKey}";

        $payload = [
            'contents' => self::convertMessages($messages),
            'generationConfig' => [
                'maxOutputTokens' => $this->maxTokens,
            ],
        ];

        if ($systemPrompt) {
            $payload['systemInstruction'] = [
                'parts' => [['text' => $systemPrompt]],
            ];
        }

        if (! empty($tools)) {
            $payload['tools'] = [
                ['functionDeclarations' => self::convertTools($tools)],
            ];
        }

        $contentBlocks = [];
        $currentIndex = -1;
        $errorBody = '';
        $lineBuffer = '';

        $ch = curl_init($url);

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $data) use (
                &$lineBuffer,
                &$contentBlocks,
                &$currentIndex,
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

                    if ($line === '' || ! str_starts_with($line, 'data: ')) {
                        continue;
                    }

                    $json = substr($line, 6);
                    $event = json_decode($json, true);
                    if (! $event) {
                        continue;
                    }

                    $this->processChunk($event, $contentBlocks, $currentIndex, $onEvent);
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
        callable $onEvent,
    ): void {
        $parts = $event['candidates'][0]['content']['parts'] ?? [];

        foreach ($parts as $part) {
            if (isset($part['text'])) {
                if (! isset($contentBlocks[$currentIndex]) || ($contentBlocks[$currentIndex]['type'] ?? '') !== 'text') {
                    $currentIndex++;
                    $contentBlocks[$currentIndex] = ['type' => 'text', 'text' => ''];
                }
                $contentBlocks[$currentIndex]['text'] .= $part['text'];
                $onEvent('text_delta', ['text' => $part['text']]);
            }

            if (isset($part['functionCall'])) {
                $currentIndex++;
                $name = $part['functionCall']['name'];
                $args = $part['functionCall']['args'] ?? [];

                $contentBlocks[$currentIndex] = [
                    'type' => 'tool_use',
                    'id' => 'gemini_'.uniqid(),
                    'name' => $name,
                    'input' => $args ?: new \stdClass,
                ];

                $onEvent('tool_use_start', [
                    'id' => $contentBlocks[$currentIndex]['id'],
                    'name' => $name,
                    'input' => $args ?: new \stdClass,
                ]);
            }
        }

        // Usage info
        $usage = $event['usageMetadata'] ?? null;
        if ($usage) {
            $onEvent('usage', [
                'input_tokens' => $usage['promptTokenCount'] ?? 0,
                'output_tokens' => $usage['candidatesTokenCount'] ?? 0,
            ]);
        }

        // Finish reason
        $finishReason = $event['candidates'][0]['finishReason'] ?? null;
        if ($finishReason === 'STOP') {
            $onEvent('message_stop', ['stop_reason' => 'end_turn']);
        }
    }

    /**
     * Convert messages to Gemini format.
     */
    private static function convertMessages(array $messages): array
    {
        $contents = [];

        foreach ($messages as $msg) {
            $role = $msg['role'] ?? 'user';
            $content = $msg['content'] ?? '';

            // Map roles
            $geminiRole = $role === 'assistant' ? 'model' : 'user';

            if (is_string($content)) {
                $contents[] = [
                    'role' => $geminiRole,
                    'parts' => [['text' => $content]],
                ];

                continue;
            }

            if (is_array($content)) {
                $parts = [];
                foreach ($content as $block) {
                    $type = $block['type'] ?? '';

                    if ($type === 'text') {
                        $parts[] = ['text' => $block['text'] ?? ''];
                    } elseif ($type === 'tool_use') {
                        $parts[] = [
                            'functionCall' => [
                                'name' => $block['name'] ?? '',
                                'args' => $block['input'] ?? new \stdClass,
                            ],
                        ];
                    } elseif ($type === 'tool_result') {
                        $parts[] = [
                            'functionResponse' => [
                                'name' => $block['tool_use_id'] ?? '',
                                'response' => json_decode($block['content'] ?? '{}', true) ?: [],
                            ],
                        ];
                    }
                }

                if ($parts) {
                    $contents[] = ['role' => $geminiRole, 'parts' => $parts];
                }
            }
        }

        return $contents;
    }

    /**
     * Convert tools to Gemini's functionDeclarations format.
     */
    private static function convertTools(array $tools): array
    {
        return array_map(fn ($tool) => [
            'name' => $tool['name'],
            'description' => $tool['description'] ?? '',
            'parameters' => self::sanitizeSchema($tool['input_schema'] ?? ['type' => 'object']),
        ], $tools);
    }

    /**
     * Gemini's schema is stricter — only supports a subset of JSON Schema.
     * Remove unsupported keys and ensure compatibility.
     */
    private static function sanitizeSchema(array $schema): array
    {
        // Remove keys Gemini doesn't support
        unset($schema['additionalProperties'], $schema['$schema'], $schema['title']);

        // Gemini rejects empty enum values — filter them out
        if (isset($schema['enum']) && is_array($schema['enum'])) {
            $schema['enum'] = array_values(array_filter($schema['enum'], fn ($v) => $v !== '' && $v !== null));
            if (empty($schema['enum'])) {
                unset($schema['enum']);
            }
        }

        // Gemini doesn't support type arrays like ["string", "object"].
        // Flatten to the first type.
        if (isset($schema['type']) && is_array($schema['type'])) {
            $schema['type'] = $schema['type'][0];
        }

        // Gemini doesn't support oneOf/anyOf — flatten to first option
        foreach (['oneOf', 'anyOf'] as $key) {
            if (isset($schema[$key]) && is_array($schema[$key])) {
                $first = $schema[$key][0] ?? [];
                unset($schema[$key]);
                if (is_array($first)) {
                    $schema = array_merge($schema, $first);
                }
            }
        }

        // Recursively sanitize nested schemas
        if (isset($schema['properties']) && is_array($schema['properties'])) {
            foreach ($schema['properties'] as &$prop) {
                if (is_array($prop)) {
                    $prop = self::sanitizeSchema($prop);
                }
            }
        }

        if (isset($schema['items']) && is_array($schema['items'])) {
            $schema['items'] = self::sanitizeSchema($schema['items']);
        }

        return $schema;
    }
}
