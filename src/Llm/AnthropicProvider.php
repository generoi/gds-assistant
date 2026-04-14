<?php

namespace GeneroWP\Assistant\Llm;

class AnthropicProvider implements LlmProviderInterface
{
    private const API_URL = 'https://api.anthropic.com/v1/messages';

    private const API_VERSION = '2023-06-01';

    /** Friendly name → model ID mapping */
    public const MODELS = [
        'haiku' => 'claude-haiku-4-5-20251001',
        'sonnet' => 'claude-sonnet-4-6',
        'opus' => 'claude-opus-4-6',
    ];

    public function __construct(
        private readonly string $apiKey,
        private readonly string $model = 'claude-sonnet-4-6',
        private readonly int $maxTokens = 4096,
        private readonly bool $useAdvisor = false,
    ) {}

    public function name(): string
    {
        return 'anthropic';
    }

    public function stream(
        array $messages,
        array $tools,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'stream' => true,
            'messages' => self::convertUrlImages($messages),
        ];

        if ($systemPrompt) {
            // Use cache_control on system prompt — it's stable across turns
            $payload['system'] = [
                [
                    'type' => 'text',
                    'text' => $systemPrompt,
                    'cache_control' => ['type' => 'ephemeral'],
                ],
            ];
        }

        if (! empty($tools)) {
            $payload['tools'] = $tools;
            // Mark last tool with cache_control — tools are stable across turns
            $lastIdx = count($payload['tools']) - 1;
            $payload['tools'][$lastIdx]['cache_control'] = ['type' => 'ephemeral'];
        }

        // Advisor strategy: add advisor tool with Opus as the advisor model
        if ($this->useAdvisor) {
            $payload['tools'][] = [
                'type' => 'advisor_20260301',
                'name' => 'advisor',
                'model' => self::MODELS['opus'],
            ];
        }

        $contentBlocks = [];
        $currentIndex = -1;
        $inputJsonBuffer = '';
        $errorBody = '';

        $lineBuffer = '';

        $ch = curl_init(self::API_URL);

        $headers = [
            'Content-Type: application/json',
            'x-api-key: '.$this->apiKey,
            'anthropic-version: '.self::API_VERSION,
        ];

        if ($this->useAdvisor) {
            $headers[] = 'anthropic-beta: advisor-tool-2026-03-01';
        }

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $data) use (
                &$lineBuffer,
                &$contentBlocks,
                &$currentIndex,
                &$inputJsonBuffer,
                &$errorBody,
                $onEvent,
            ) {
                // Capture non-SSE error responses
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                if ($httpCode >= 400) {
                    $errorBody .= $data;

                    return strlen($data);
                }

                $lineBuffer .= $data;

                while (($newlinePos = strpos($lineBuffer, "\n")) !== false) {
                    $line = substr($lineBuffer, 0, $newlinePos);
                    $lineBuffer = substr($lineBuffer, $newlinePos + 1);

                    $line = trim($line);
                    if ($line === '' || str_starts_with($line, ':')) {
                        continue;
                    }

                    if (str_starts_with($line, 'event: ')) {
                        continue;
                    }

                    if (! str_starts_with($line, 'data: ')) {
                        continue;
                    }

                    $json = substr($line, 6);
                    $event = json_decode($json, true);
                    if (! $event || ! isset($event['type'])) {
                        continue;
                    }

                    $this->processEvent(
                        $event,
                        $contentBlocks,
                        $currentIndex,
                        $inputJsonBuffer,
                        $onEvent,
                    );
                }

                return strlen($data);
            },
        ]);

        $result = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($result === false) {
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

    private function processEvent(
        array $event,
        array &$contentBlocks,
        int &$currentIndex,
        string &$inputJsonBuffer,
        callable $onEvent,
    ): void {
        switch ($event['type']) {
            case 'content_block_start':
                $currentIndex = $event['index'];
                $block = $event['content_block'];

                if ($block['type'] === 'text') {
                    $contentBlocks[$currentIndex] = ['type' => 'text', 'text' => ''];
                } elseif ($block['type'] === 'tool_use') {
                    $inputJsonBuffer = '';
                    $contentBlocks[$currentIndex] = [
                        'type' => 'tool_use',
                        'id' => $block['id'],
                        'name' => $block['name'],
                        'input' => new \stdClass,
                    ];

                    $onEvent('tool_use_start', [
                        'id' => $block['id'],
                        'name' => $block['name'],
                        'input' => new \stdClass,
                    ]);
                } elseif ($block['type'] === 'server_tool_use') {
                    // Advisor tool call — store in content blocks for round-tripping
                    $contentBlocks[$currentIndex] = [
                        'type' => 'server_tool_use',
                        'id' => $block['id'],
                        'name' => $block['name'],
                        'input' => new \stdClass,
                    ];
                    $onEvent('text_delta', ['text' => "\n_Consulting advisor..._\n"]);
                } elseif ($block['type'] === 'advisor_tool_result') {
                    // Advisor result — store verbatim for round-tripping
                    $contentBlocks[$currentIndex] = [
                        'type' => 'advisor_tool_result',
                        'tool_use_id' => $block['tool_use_id'],
                        'content' => $block['content'],
                    ];
                }
                break;

            case 'content_block_delta':
                $delta = $event['delta'];

                if ($delta['type'] === 'text_delta' && isset($contentBlocks[$currentIndex])) {
                    $contentBlocks[$currentIndex]['text'] .= $delta['text'];
                    $onEvent('text_delta', ['text' => $delta['text']]);
                } elseif ($delta['type'] === 'input_json_delta') {
                    $inputJsonBuffer .= $delta['partial_json'];
                }
                break;

            case 'content_block_stop':
                if (isset($contentBlocks[$currentIndex]) && ($contentBlocks[$currentIndex]['type'] ?? '') === 'tool_use') {
                    $parsed = json_decode($inputJsonBuffer, true);
                    // Must be an object (not array) for the Anthropic API — {} not []
                    $contentBlocks[$currentIndex]['input'] = $parsed ?: new \stdClass;
                }
                $inputJsonBuffer = '';
                break;

            case 'message_stop':
                $onEvent('message_stop', [
                    'stop_reason' => 'end_turn',
                ]);
                break;

            case 'message_delta':
                if (isset($event['usage'])) {
                    $onEvent('usage', [
                        'input_tokens' => $event['usage']['input_tokens'] ?? 0,
                        'output_tokens' => $event['usage']['output_tokens'] ?? 0,
                    ]);
                }
                break;

            case 'error':
                $onEvent('error', [
                    'message' => $event['error']['message'] ?? 'Unknown API error',
                ]);
                break;
        }
    }

    /**
     * Convert URL-based image blocks to base64 for the Anthropic API.
     * Anthropic can't fetch arbitrary URLs (especially local/private ones).
     */
    private static function convertUrlImages(array $messages): array
    {
        return array_map(function (array $msg) {
            if (! is_array($msg['content'] ?? null)) {
                return $msg;
            }

            $msg['content'] = array_map(function ($block) {
                if (($block['type'] ?? '') !== 'image') {
                    return $block;
                }

                $source = $block['source'] ?? [];
                if (($source['type'] ?? '') !== 'url') {
                    return $block;
                }

                $url = $source['url'] ?? '';
                $imageData = @file_get_contents($url);
                if (! $imageData) {
                    return $block;
                }

                $finfo = new \finfo(FILEINFO_MIME_TYPE);
                $mediaType = $finfo->buffer($imageData) ?: 'image/jpeg';

                return [
                    'type' => 'image',
                    'source' => [
                        'type' => 'base64',
                        'media_type' => $mediaType,
                        'data' => base64_encode($imageData),
                    ],
                ];
            }, $msg['content']);

            return $msg;
        }, $messages);
    }
}
