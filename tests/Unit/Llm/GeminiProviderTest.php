<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\GeminiProvider;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class GeminiProviderTest extends TestCase
{
    private GeminiProvider $provider;

    private ReflectionMethod $processChunk;

    private ReflectionMethod $convertMessages;

    private ReflectionMethod $convertTools;

    private ReflectionMethod $sanitizeSchema;

    protected function setUp(): void
    {
        parent::setUp();
        $this->provider = new GeminiProvider('test-key', 'gemini-2.5-flash');
        $this->processChunk = new ReflectionMethod(GeminiProvider::class, 'processChunk');
        $this->processChunk->setAccessible(true);
        $this->convertMessages = new ReflectionMethod(GeminiProvider::class, 'convertMessages');
        $this->convertMessages->setAccessible(true);
        $this->convertTools = new ReflectionMethod(GeminiProvider::class, 'convertTools');
        $this->convertTools->setAccessible(true);
        $this->sanitizeSchema = new ReflectionMethod(GeminiProvider::class, 'sanitizeSchema');
        $this->sanitizeSchema->setAccessible(true);
    }

    public function test_name(): void
    {
        $this->assertSame('gemini', $this->provider->name());
    }

    public function test_parses_text_stream(): void
    {
        $events = $this->replayFixture('gemini-text-only.txt');

        $this->assertCount(1, $events['blocks']);
        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertSame('Hello! I can help you manage your site.', $events['blocks'][0]['text']);

        $textDeltas = array_filter($events['callbacks'], fn ($e) => $e[0] === 'text_delta');
        $this->assertGreaterThanOrEqual(2, count($textDeltas));

        // Usage
        $usageEvents = array_filter($events['callbacks'], fn ($e) => $e[0] === 'usage');
        $this->assertNotEmpty($usageEvents);

        // message_stop on STOP finish reason
        $stops = array_filter($events['callbacks'], fn ($e) => $e[0] === 'message_stop');
        $this->assertCount(1, $stops);
    }

    public function test_parses_function_call(): void
    {
        $events = $this->replayFixture('gemini-function-call.txt');

        // Text + tool_use
        $this->assertCount(2, $events['blocks']);
        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertStringContainsString('list the pages', $events['blocks'][0]['text']);

        $toolBlock = $events['blocks'][1];
        $this->assertSame('tool_use', $toolBlock['type']);
        $this->assertSame('gds__content-list', $toolBlock['name']);
        $this->assertStringStartsWith('gemini_', $toolBlock['id']);

        // Input is parsed directly (not from JSON fragments)
        $this->assertSame('page', $toolBlock['input']['type']);
        $this->assertSame(10, $toolBlock['input']['per_page']);

        // Should have tool_use_start callback
        $toolStarts = array_filter($events['callbacks'], fn ($e) => $e[0] === 'tool_use_start');
        $this->assertCount(1, $toolStarts);
    }

    public function test_empty_function_args_returns_stdclass(): void
    {
        $contentBlocks = [];
        $currentIndex = -1;
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        $this->processChunk->invokeArgs($this->provider, [
            ['candidates' => [['content' => ['parts' => [
                ['functionCall' => ['name' => 'test_tool', 'args' => []]],
            ]], 'index' => 0]]],
            &$contentBlocks, &$currentIndex, $onEvent,
        ]);

        $this->assertCount(1, $contentBlocks);
        $this->assertInstanceOf(\stdClass::class, $contentBlocks[0]['input']);
    }

    public function test_convert_messages_simple(): void
    {
        $messages = [
            ['role' => 'user', 'content' => 'Hello'],
            ['role' => 'assistant', 'content' => 'Hi there'],
        ];

        $result = $this->convertMessages->invoke(null, $messages);

        $this->assertCount(2, $result);
        $this->assertSame('user', $result[0]['role']);
        $this->assertSame([['text' => 'Hello']], $result[0]['parts']);
        $this->assertSame('model', $result[1]['role']);
        $this->assertSame([['text' => 'Hi there']], $result[1]['parts']);
    }

    public function test_convert_messages_tool_use(): void
    {
        $messages = [
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'text', 'text' => 'Searching...'],
                    ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'search', 'input' => ['q' => 'test']],
                ],
            ],
        ];

        $result = $this->convertMessages->invoke(null, $messages);

        $this->assertCount(1, $result);
        $this->assertSame('model', $result[0]['role']);
        $this->assertCount(2, $result[0]['parts']);
        $this->assertSame('Searching...', $result[0]['parts'][0]['text']);
        $this->assertSame('search', $result[0]['parts'][1]['functionCall']['name']);
    }

    public function test_convert_messages_with_image(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this image'],
                    ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/jpeg', 'data' => '/9j/4AAQ']],
                ],
            ],
        ];

        $result = $this->convertMessages->invoke(null, $messages);

        $this->assertCount(1, $result);
        $this->assertSame('user', $result[0]['role']);
        $this->assertCount(2, $result[0]['parts']);
        $this->assertSame('Describe this image', $result[0]['parts'][0]['text']);
        $this->assertArrayHasKey('inlineData', $result[0]['parts'][1]);
        $this->assertSame('image/jpeg', $result[0]['parts'][1]['inlineData']['mimeType']);
        $this->assertSame('/9j/4AAQ', $result[0]['parts'][1]['inlineData']['data']);
    }

    public function test_convert_messages_with_url_image_unreachable(): void
    {
        // URL images that can't be fetched should be silently skipped
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this'],
                    ['type' => 'image', 'source' => ['type' => 'url', 'url' => 'https://nonexistent.invalid/photo.jpg']],
                ],
            ],
        ];

        $result = $this->convertMessages->invoke(null, $messages);

        $this->assertCount(1, $result);
        // Text part should still be there, image silently dropped
        $textParts = array_filter($result[0]['parts'], fn ($p) => isset($p['text']));
        $this->assertNotEmpty($textParts);
    }

    public function test_convert_messages_tool_result(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_1', 'content' => '{"found":true}'],
                ],
            ],
        ];

        $result = $this->convertMessages->invoke(null, $messages);

        $this->assertCount(1, $result);
        $this->assertSame('user', $result[0]['role']);
        $this->assertArrayHasKey('functionResponse', $result[0]['parts'][0]);
        $this->assertSame(['found' => true], $result[0]['parts'][0]['functionResponse']['response']);
    }

    public function test_convert_tools(): void
    {
        $tools = [
            [
                'name' => 'gds__content-list',
                'description' => 'List content',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => ['type' => ['type' => 'string']],
                ],
            ],
        ];

        $result = $this->convertTools->invoke(null, $tools);

        $this->assertCount(1, $result);
        $this->assertSame('gds__content-list', $result[0]['name']);
        $this->assertSame('List content', $result[0]['description']);
        $this->assertArrayHasKey('parameters', $result[0]);
    }

    public function test_sanitize_schema_removes_unsupported_keys(): void
    {
        $schema = [
            'type' => 'object',
            'additionalProperties' => false,
            '$schema' => 'http://json-schema.org/draft-07/schema#',
            'title' => 'Test',
            'properties' => [],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertArrayNotHasKey('additionalProperties', $result);
        $this->assertArrayNotHasKey('$schema', $result);
        $this->assertArrayNotHasKey('title', $result);
    }

    public function test_sanitize_schema_converts_integer_enums_to_strings(): void
    {
        $schema = [
            'type' => 'integer',
            'enum' => [301, 302, 307],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertSame('string', $result['type']);
        $this->assertSame(['301', '302', '307'], $result['enum']);
    }

    public function test_sanitize_schema_removes_empty_enums(): void
    {
        $schema = [
            'type' => 'string',
            'enum' => ['', null],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertArrayNotHasKey('enum', $result);
    }

    public function test_sanitize_schema_flattens_type_arrays(): void
    {
        $schema = ['type' => ['string', 'object']];
        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertSame('string', $result['type']);
    }

    public function test_sanitize_schema_flattens_oneof(): void
    {
        $schema = [
            'oneOf' => [
                ['type' => 'string'],
                ['type' => 'object', 'properties' => []],
            ],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertArrayNotHasKey('oneOf', $result);
        $this->assertSame('string', $result['type']);
    }

    public function test_sanitize_schema_flattens_anyof(): void
    {
        $schema = [
            'anyOf' => [
                ['type' => 'object', 'properties' => ['id' => ['type' => 'integer']]],
                ['type' => 'string'],
            ],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertArrayNotHasKey('anyOf', $result);
        $this->assertSame('object', $result['type']);
    }

    public function test_sanitize_schema_recurses_properties(): void
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'redirect' => [
                    'type' => 'integer',
                    'enum' => [301, 302],
                    'title' => 'Redirect Code',
                ],
                'tags' => [
                    'type' => 'array',
                    'items' => [
                        'type' => ['string', 'integer'],
                        'additionalProperties' => true,
                    ],
                ],
            ],
        ];

        $result = $this->sanitizeSchema->invoke(null, $schema);
        $this->assertSame('string', $result['properties']['redirect']['type']);
        $this->assertSame(['301', '302'], $result['properties']['redirect']['enum']);
        $this->assertArrayNotHasKey('title', $result['properties']['redirect']);
        $this->assertSame('string', $result['properties']['tags']['items']['type']);
        $this->assertArrayNotHasKey('additionalProperties', $result['properties']['tags']['items']);
    }

    /**
     * Replay SSE fixture through processChunk and collect results.
     */
    private function replayFixture(string $filename): array
    {
        $fixture = file_get_contents(__DIR__.'/../../fixtures/'.$filename);
        $contentBlocks = [];
        $currentIndex = -1;
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        $lines = explode("\n", $fixture);
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || ! str_starts_with($line, 'data: ')) {
                continue;
            }

            $json = substr($line, 6);
            $event = json_decode($json, true);
            if (! $event) {
                continue;
            }

            $this->processChunk->invokeArgs(
                $this->provider,
                [$event, &$contentBlocks, &$currentIndex, $onEvent],
            );
        }

        return ['blocks' => $contentBlocks, 'callbacks' => $callbacks];
    }
}
