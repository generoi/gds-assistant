<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\AnthropicProvider;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class AnthropicProviderTest extends TestCase
{
    private AnthropicProvider $provider;

    private ReflectionMethod $processEvent;

    protected function setUp(): void
    {
        parent::setUp();
        $this->provider = new AnthropicProvider('test-key', 'claude-sonnet-4-6');
        $this->processEvent = new ReflectionMethod(AnthropicProvider::class, 'processEvent');
        $this->processEvent->setAccessible(true);
    }

    public function test_name(): void
    {
        $this->assertSame('anthropic', $this->provider->name());
    }

    public function test_parses_text_stream(): void
    {
        $events = $this->replayFixture('anthropic-text-only.txt');

        // Should have one text block
        $this->assertCount(1, $events['blocks']);
        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertSame('Hello! I can help you manage your site.', $events['blocks'][0]['text']);

        // Should have emitted text_delta events
        $textDeltas = array_filter($events['callbacks'], fn ($e) => $e[0] === 'text_delta');
        $this->assertCount(2, $textDeltas);

        // Should have usage
        $usageEvents = array_filter($events['callbacks'], fn ($e) => $e[0] === 'usage');
        $this->assertNotEmpty($usageEvents);
        $usage = array_values($usageEvents)[0][1];
        $this->assertSame(100, $usage['input_tokens']);
        $this->assertSame(20, $usage['output_tokens']);

        // Should have message_stop
        $stops = array_filter($events['callbacks'], fn ($e) => $e[0] === 'message_stop');
        $this->assertCount(1, $stops);
    }

    public function test_parses_tool_call_with_json_fragments(): void
    {
        $events = $this->replayFixture('anthropic-tool-call.txt');

        // Should have text + tool_use blocks
        $this->assertCount(2, $events['blocks']);
        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertSame('Let me list the pages.', $events['blocks'][0]['text']);

        $toolBlock = $events['blocks'][1];
        $this->assertSame('tool_use', $toolBlock['type']);
        $this->assertSame('toolu_abc123', $toolBlock['id']);
        $this->assertSame('gds__content-list', $toolBlock['name']);

        // Input should be parsed from accumulated JSON fragments
        $input = $toolBlock['input'];
        $this->assertSame('page', $input['type']);
        $this->assertSame(10, $input['per_page']);

        // Should have emitted tool_use_start
        $toolStarts = array_filter($events['callbacks'], fn ($e) => $e[0] === 'tool_use_start');
        $this->assertCount(1, $toolStarts);
        $start = array_values($toolStarts)[0][1];
        $this->assertSame('toolu_abc123', $start['id']);
        $this->assertSame('gds__content-list', $start['name']);
    }

    public function test_parses_advisor_blocks(): void
    {
        $events = $this->replayFixture('anthropic-advisor.txt');

        // Should have: text, server_tool_use, advisor_tool_result, text
        $this->assertCount(4, $events['blocks']);

        $this->assertSame('text', $events['blocks'][0]['type']);
        $this->assertSame('Let me think about this.', $events['blocks'][0]['text']);

        $this->assertSame('server_tool_use', $events['blocks'][1]['type']);
        $this->assertSame('srvtoolu_adv1', $events['blocks'][1]['id']);
        $this->assertSame('advisor', $events['blocks'][1]['name']);

        $this->assertSame('advisor_tool_result', $events['blocks'][2]['type']);
        $this->assertSame('srvtoolu_adv1', $events['blocks'][2]['tool_use_id']);

        $this->assertSame('text', $events['blocks'][3]['type']);
        $this->assertStringContainsString('query loop', $events['blocks'][3]['text']);

        // Advisor start should emit a "Consulting advisor" text_delta
        $textDeltas = array_filter($events['callbacks'], fn ($e) => $e[0] === 'text_delta');
        $texts = array_map(fn ($e) => $e[1]['text'], array_values($textDeltas));
        $advisorText = array_filter($texts, fn ($t) => str_contains($t, 'advisor'));
        $this->assertNotEmpty($advisorText);
    }

    public function test_error_event(): void
    {
        $contentBlocks = [];
        $currentIndex = -1;
        $inputJsonBuffer = '';
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        $event = [
            'type' => 'error',
            'error' => ['message' => 'Rate limit exceeded'],
        ];

        $this->processEvent->invokeArgs(
            $this->provider,
            [$event, &$contentBlocks, &$currentIndex, &$inputJsonBuffer, $onEvent],
        );

        $this->assertCount(1, $callbacks);
        $this->assertSame('error', $callbacks[0][0]);
        $this->assertSame('Rate limit exceeded', $callbacks[0][1]['message']);
    }

    public function test_empty_tool_input_returns_stdclass(): void
    {
        $contentBlocks = [];
        $currentIndex = -1;
        $inputJsonBuffer = '';
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        // Start a tool_use block
        $this->processEvent->invokeArgs($this->provider, [
            ['type' => 'content_block_start', 'index' => 0, 'content_block' => ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'test']],
            &$contentBlocks, &$currentIndex, &$inputJsonBuffer, $onEvent,
        ]);

        // Stop with empty JSON buffer
        $this->processEvent->invokeArgs($this->provider, [
            ['type' => 'content_block_stop', 'index' => 0],
            &$contentBlocks, &$currentIndex, &$inputJsonBuffer, $onEvent,
        ]);

        // Input should be stdClass (not null or empty array)
        $this->assertInstanceOf(\stdClass::class, $contentBlocks[0]['input']);
    }

    public function test_ping_events_are_ignored(): void
    {
        $events = $this->replayFixture('anthropic-text-only.txt');

        // Ping events should not produce any callbacks or blocks
        $pings = array_filter($events['callbacks'], fn ($e) => $e[0] === 'ping');
        $this->assertEmpty($pings);
    }

    /**
     * Replay SSE fixture through processEvent and collect results.
     */
    private function replayFixture(string $filename): array
    {
        $fixture = file_get_contents(__DIR__.'/../../fixtures/'.$filename);
        $contentBlocks = [];
        $currentIndex = -1;
        $inputJsonBuffer = '';
        $callbacks = [];

        $onEvent = function (string $type, array $data) use (&$callbacks) {
            $callbacks[] = [$type, $data];
        };

        // Parse SSE lines (same logic as the provider's WRITEFUNCTION)
        $lines = explode("\n", $fixture);
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, ':') || str_starts_with($line, 'event: ')) {
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

            $this->processEvent->invokeArgs(
                $this->provider,
                [$event, &$contentBlocks, &$currentIndex, &$inputJsonBuffer, $onEvent],
            );
        }

        return ['blocks' => $contentBlocks, 'callbacks' => $callbacks];
    }
}
