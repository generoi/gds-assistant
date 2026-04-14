<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\OpenAiCompatibleProvider;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class OpenAiProviderTest extends TestCase
{
    private OpenAiCompatibleProvider $provider;

    private ReflectionMethod $processChunk;

    private ReflectionMethod $convertTools;

    private ReflectionMethod $sanitizeSchema;

    private ReflectionMethod $convertMessage;

    protected function setUp(): void
    {
        parent::setUp();
        $this->provider = new OpenAiCompatibleProvider('test-key', 'gpt-4o');
        $this->processChunk = new ReflectionMethod(OpenAiCompatibleProvider::class, 'processChunk');
        $this->processChunk->setAccessible(true);
        $this->convertTools = new ReflectionMethod(OpenAiCompatibleProvider::class, 'convertTools');
        $this->convertTools->setAccessible(true);
        $this->sanitizeSchema = new ReflectionMethod(OpenAiCompatibleProvider::class, 'sanitizeSchema');
        $this->sanitizeSchema->setAccessible(true);
        $this->convertMessage = new ReflectionMethod(OpenAiCompatibleProvider::class, 'convertMessage');
        $this->convertMessage->setAccessible(true);
    }

    public function test_name(): void
    {
        $this->assertSame('openai', $this->provider->name());

        $groq = new OpenAiCompatibleProvider('key', 'model', 4096, 'https://api.groq.com/openai/v1', 'groq');
        $this->assertSame('groq', $groq->name());
    }

    public function test_parses_text_stream(): void
    {
        $events = $this->replayFixture('openai-text-only.txt');

        $this->assertCount(1, $events['blocks']);
        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertSame('Hello! I can help you.', $events['blocks'][0]['text']);

        $textDeltas = array_filter($events['callbacks'], fn ($e) => $e[0] === 'text_delta');
        $this->assertCount(2, $textDeltas);

        // Note: OpenAI provider only emits message_stop when finish_reason=stop
        // AND there are unflushed tool buffers. For pure text, no message_stop is emitted.
        // The ChatEndpoint relies on the stream ending, not this event.

        // Usage
        $usageEvents = array_filter($events['callbacks'], fn ($e) => $e[0] === 'usage');
        $this->assertNotEmpty($usageEvents);
        $usage = array_values($usageEvents)[0][1];
        $this->assertSame(50, $usage['input_tokens']);
        $this->assertSame(10, $usage['output_tokens']);
    }

    public function test_parses_tool_call_with_argument_accumulation(): void
    {
        $events = $this->replayFixture('openai-tool-call.txt');

        // Text block + tool_use block
        $this->assertCount(2, $events['blocks']);
        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertSame('Let me list the pages.', $events['blocks'][0]['text']);

        $toolBlock = $events['blocks'][1];
        $this->assertSame('tool_use', $toolBlock['type']);
        $this->assertSame('call_abc123', $toolBlock['id']);
        $this->assertSame('gds__content-list', $toolBlock['name']);

        // Input should be parsed from accumulated argument strings
        $input = $toolBlock['input'];
        $this->assertSame('page', $input['type']);
        $this->assertSame(10, $input['per_page']);

        // Should have emitted tool_use_start
        $toolStarts = array_filter($events['callbacks'], fn ($e) => $e[0] === 'tool_use_start');
        $this->assertCount(1, $toolStarts);
    }

    public function test_convert_tools(): void
    {
        $tools = [
            [
                'name' => 'gds__content-list',
                'description' => 'List content',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'type' => ['type' => 'string'],
                    ],
                ],
            ],
        ];

        $result = $this->convertTools->invoke(null, $tools);

        $this->assertCount(1, $result);
        $this->assertSame('function', $result[0]['type']);
        $this->assertSame('gds__content-list', $result[0]['function']['name']);
        $this->assertSame('List content', $result[0]['function']['description']);
        $this->assertArrayHasKey('parameters', $result[0]['function']);
    }

    public function test_sanitize_schema_flattens_type_arrays(): void
    {
        $schema = ['type' => ['string', 'object'], 'properties' => []];
        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertSame('string', $result['type']);
    }

    public function test_sanitize_schema_adds_missing_array_items(): void
    {
        $schema = ['type' => 'array'];
        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertSame(['type' => 'string'], $result['items']);
    }

    public function test_sanitize_schema_recurses_properties(): void
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'tags' => ['type' => 'array'],
                'meta' => ['type' => ['string', 'null']],
            ],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertSame(['type' => 'string'], $result['properties']['tags']['items']);
        $this->assertSame('string', $result['properties']['meta']['type']);
    }

    public function test_convert_message_simple_string(): void
    {
        $msg = ['role' => 'user', 'content' => 'Hello'];
        $result = $this->convertMessage->invoke(null, $msg);
        $this->assertSame(['role' => 'user', 'content' => 'Hello'], $result);
    }

    public function test_convert_message_text_blocks(): void
    {
        $msg = [
            'role' => 'assistant',
            'content' => [
                ['type' => 'text', 'text' => 'Hello '],
                ['type' => 'text', 'text' => 'world'],
            ],
        ];

        $result = $this->convertMessage->invoke(null, $msg);
        $this->assertSame('assistant', $result['role']);
        $this->assertSame('Hello world', $result['content']);
    }

    public function test_convert_message_tool_use(): void
    {
        $msg = [
            'role' => 'assistant',
            'content' => [
                ['type' => 'text', 'text' => 'Let me check.'],
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'search', 'input' => ['q' => 'test']],
            ],
        ];

        $result = $this->convertMessage->invoke(null, $msg);
        $this->assertSame('assistant', $result['role']);
        $this->assertSame('Let me check.', $result['content']);
        $this->assertCount(1, $result['tool_calls']);
        $this->assertSame('toolu_1', $result['tool_calls'][0]['id']);
        $this->assertSame('function', $result['tool_calls'][0]['type']);
        $this->assertSame('search', $result['tool_calls'][0]['function']['name']);
    }

    public function test_convert_message_tool_result(): void
    {
        $msg = [
            'role' => 'user',
            'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 'toolu_1', 'content' => '{"found":true}'],
            ],
        ];

        $result = $this->convertMessage->invoke(null, $msg);
        $this->assertSame('tool', $result['role']);
        $this->assertSame('toolu_1', $result['tool_call_id']);
        $this->assertSame('{"found":true}', $result['content']);
    }

    public function test_convert_message_with_image(): void
    {
        $msg = [
            'role' => 'user',
            'content' => [
                ['type' => 'text', 'text' => 'What is this?'],
                ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => 'iVBOR']],
            ],
        ];

        $result = $this->convertMessage->invoke(null, $msg);
        $this->assertSame('user', $result['role']);
        $this->assertIsArray($result['content']);
        $this->assertCount(2, $result['content']);
        $this->assertSame('text', $result['content'][0]['type']);
        $this->assertSame('image_url', $result['content'][1]['type']);
        $this->assertStringStartsWith('data:image/png;base64,', $result['content'][1]['image_url']['url']);
    }

    public function test_convert_message_text_only_not_array(): void
    {
        // Text-only content should NOT return array format
        $msg = [
            'role' => 'user',
            'content' => [
                ['type' => 'text', 'text' => 'Just text'],
            ],
        ];

        $result = $this->convertMessage->invoke(null, $msg);
        $this->assertSame('user', $result['role']);
        $this->assertSame('Just text', $result['content']);
    }

    public function test_unflushed_buffer_fallback(): void
    {
        $contentBlocks = [];
        $currentIndex = -1;
        $toolCallBuffers = [];
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        // Simulate a tool call start
        $this->processChunk->invokeArgs($this->provider, [
            ['choices' => [['delta' => [
                'tool_calls' => [[
                    'index' => 0,
                    'id' => 'call_test',
                    'type' => 'function',
                    'function' => ['name' => 'test_tool', 'arguments' => ''],
                ]],
            ], 'finish_reason' => null]]],
            &$contentBlocks, &$currentIndex, &$toolCallBuffers, $onEvent,
        ]);

        // Simulate argument chunks
        $this->processChunk->invokeArgs($this->provider, [
            ['choices' => [['delta' => [
                'tool_calls' => [[
                    'index' => 0,
                    'function' => ['arguments' => '{"key":'],
                ]],
            ], 'finish_reason' => null]]],
            &$contentBlocks, &$currentIndex, &$toolCallBuffers, $onEvent,
        ]);

        $this->processChunk->invokeArgs($this->provider, [
            ['choices' => [['delta' => [
                'tool_calls' => [[
                    'index' => 0,
                    'function' => ['arguments' => '"value"}'],
                ]],
            ], 'finish_reason' => null]]],
            &$contentBlocks, &$currentIndex, &$toolCallBuffers, $onEvent,
        ]);

        // Finish with tool_calls
        $this->processChunk->invokeArgs($this->provider, [
            ['choices' => [['delta' => [], 'finish_reason' => 'tool_calls']]],
            &$contentBlocks, &$currentIndex, &$toolCallBuffers, $onEvent,
        ]);

        // Content block should have parsed input
        $this->assertCount(1, $contentBlocks);
        $this->assertSame('tool_use', $contentBlocks[0]['type']);
        $this->assertSame(['key' => 'value'], $contentBlocks[0]['input']);
    }

    /**
     * Replay SSE fixture through processChunk and collect results.
     */
    private function replayFixture(string $filename): array
    {
        $fixture = file_get_contents(__DIR__.'/../../fixtures/'.$filename);
        $contentBlocks = [];
        $currentIndex = -1;
        $toolCallBuffers = [];
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        $lines = explode("\n", $fixture);
        foreach ($lines as $line) {
            $line = trim($line);
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

            $this->processChunk->invokeArgs(
                $this->provider,
                [$event, &$contentBlocks, &$currentIndex, &$toolCallBuffers, $onEvent],
            );
        }

        // Simulate the post-stream buffer flush
        if (! empty($toolCallBuffers)) {
            foreach ($toolCallBuffers as $tcIdx => $tc) {
                $parsed = json_decode($tc['arguments'], true);
                foreach ($contentBlocks as &$block) {
                    if (($block['type'] ?? '') === 'tool_use' && ($block['id'] ?? '') === $tc['id']) {
                        $block['input'] = $parsed ?: new \stdClass;
                        break;
                    }
                }
            }
        }

        return ['blocks' => $contentBlocks, 'callbacks' => $callbacks];
    }
}
