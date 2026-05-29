<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Bridge\ToolProviderInterface;
use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Llm\LlmProviderInterface;
use GeneroWP\Assistant\Llm\MessageLoop;
use GeneroWP\Assistant\Tests\TestCase;

class MessageLoopTest extends TestCase
{
    /**
     * Create a mock provider that returns predetermined content blocks.
     */
    private function mockProvider(array $contentBlocks): LlmProviderInterface
    {
        return new class($contentBlocks) implements LlmProviderInterface
        {
            private int $callCount = 0;

            public function __construct(private array $responses) {}

            public function name(): string
            {
                return 'mock';
            }

            public function stream(array $messages, array $tools, callable $onEvent, ?string $systemPrompt = null): array
            {
                $blocks = $this->responses[$this->callCount] ?? [];
                $this->callCount++;

                // Emit events like a real provider would
                foreach ($blocks as $block) {
                    if (($block['type'] ?? '') === 'text') {
                        $onEvent('text_delta', ['text' => $block['text']]);
                    } elseif (($block['type'] ?? '') === 'tool_use') {
                        $onEvent('tool_use_start', [
                            'id' => $block['id'],
                            'name' => $block['name'],
                            'input' => $block['input'] ?? new \stdClass,
                        ]);
                    }
                }
                $onEvent('message_stop', ['stop_reason' => 'end_turn']);

                return $blocks;
            }
        };
    }

    /**
     * Create a mock tool provider that handles a specific tool name.
     */
    private function mockToolProvider(string $name, string $description, mixed $result): ToolProviderInterface
    {
        return new class($name, $description, $result) implements ToolProviderInterface
        {
            public function __construct(
                private string $name,
                private string $description,
                private mixed $result,
            ) {}

            public function getTools(): array
            {
                return [
                    [
                        'name' => $this->name,
                        'description' => $this->description,
                        'input_schema' => ['type' => 'object', 'properties' => []],
                    ],
                ];
            }

            public function handles(string $name): bool
            {
                return $name === $this->name;
            }

            public function executeTool(string $name, array $input): mixed
            {
                return $this->result;
            }
        };
    }

    public function test_text_only_response(): void
    {
        $provider = $this->mockProvider([
            [['type' => 'text', 'text' => 'Hello world']],
        ]);

        $registry = new ToolRegistry;
        $loop = new MessageLoop($provider, $registry);

        $events = [];
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'Hi']],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        // Should have user + assistant messages
        $this->assertCount(2, $messages);
        $this->assertSame('assistant', $messages[1]['role']);

        // Should have emitted text_delta and message_stop
        $types = array_column($events, 0);
        $this->assertContains('text_delta', $types);
        $this->assertContains('message_stop', $types);
    }

    public function test_tool_execution(): void
    {
        $this->setExpectedIncorrectUsage('WP_Abilities_Registry::get_registered');
        // First call returns a tool_use, second call returns text
        $provider = $this->mockProvider([
            [
                ['type' => 'text', 'text' => 'Let me check.'],
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'test__safe-tool', 'input' => ['q' => 'test']],
            ],
            [['type' => 'text', 'text' => 'Found it.']],
        ]);

        $registry = new ToolRegistry;
        $registry->register($this->mockToolProvider(
            'test__safe-tool',
            '[READ-ONLY] A safe tool',
            ['result' => 'ok'],
        ));

        $loop = new MessageLoop($provider, $registry);

        $events = [];
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'Search']],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        // Should have: user, assistant (tool_use), user (tool_result), assistant (text)
        $this->assertCount(4, $messages);
        $this->assertSame('user', $messages[2]['role']);

        // tool_result event should have been emitted
        $resultEvents = array_filter($events, fn ($e) => $e[0] === 'tool_result');
        $this->assertNotEmpty($resultEvents);
    }

    public function test_dangerous_tool_triggers_approval(): void
    {
        $this->setExpectedIncorrectUsage('WP_Abilities_Registry::get_registered');
        $provider = $this->mockProvider([
            [
                ['type' => 'text', 'text' => 'I will delete this.'],
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'gds__cache-clear', 'input' => new \stdClass],
            ],
        ]);

        $registry = new ToolRegistry;
        $registry->register($this->mockToolProvider(
            'gds__cache-clear',
            '[DESTRUCTIVE] Clear the site cache',
            ['cleared' => true],
        ));

        $loop = new MessageLoop($provider, $registry);

        $events = [];
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'Clear cache']],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        // Should have emitted tool_approval_required
        $approvalEvents = array_filter($events, fn ($e) => $e[0] === 'tool_approval_required');
        $this->assertCount(1, $approvalEvents);

        $approval = array_values($approvalEvents)[0][1];
        $this->assertSame('toolu_1', $approval['tool_use_id']);
        $this->assertStringContainsString('cache-clear', $approval['tool_name']);

        // Should NOT have emitted tool_result (tool wasn't executed)
        $resultEvents = array_filter($events, fn ($e) => $e[0] === 'tool_result');
        $this->assertEmpty($resultEvents);

        // Messages should contain pending_approval tool_result
        $lastMsg = end($messages);
        $this->assertSame('user', $lastMsg['role']);
        $pending = json_decode($lastMsg['content'][0]['content'], true);
        $this->assertSame('pending_approval', $pending['status']);
    }

    public function test_safe_tool_not_blocked(): void
    {
        $this->setExpectedIncorrectUsage('WP_Abilities_Registry::get_registered');
        // A read-only tool should execute without approval
        $provider = $this->mockProvider([
            [
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'gds__content-list', 'input' => ['type' => 'page']],
            ],
            [['type' => 'text', 'text' => 'Found pages.']],
        ]);

        $registry = new ToolRegistry;
        $registry->register($this->mockToolProvider(
            'gds__content-list',
            '[READ-ONLY] List content',
            ['posts' => [['id' => 1, 'title' => 'Home']]],
        ));

        $loop = new MessageLoop($provider, $registry);

        $events = [];
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'List pages']],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        // Should NOT emit approval request
        $approvalEvents = array_filter($events, fn ($e) => $e[0] === 'tool_approval_required');
        $this->assertEmpty($approvalEvents);

        // Should have emitted tool_result (tool was executed)
        $resultEvents = array_filter($events, fn ($e) => $e[0] === 'tool_result');
        $this->assertNotEmpty($resultEvents);
    }

    public function test_iteration_cap(): void
    {
        $this->setExpectedIncorrectUsage('WP_Abilities_Registry::get_registered');
        // Provider always returns a tool_use — loop should stop at max iterations
        $infiniteProvider = $this->mockProvider(array_fill(0, 30, [
            ['type' => 'tool_use', 'id' => 'toolu_loop', 'name' => 'gds__content-list', 'input' => new \stdClass],
        ]));

        $registry = new ToolRegistry;
        $registry->register($this->mockToolProvider(
            'gds__content-list',
            '[READ-ONLY] List content',
            ['posts' => []],
        ));

        // Set max iterations to 3
        add_filter('gds-assistant/max_iterations', fn () => 3);

        $loop = new MessageLoop($infiniteProvider, $registry);
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'Loop forever']],
            fn () => null,
        );

        // Should have stopped after 3 iterations (user + 3*(assistant+user))
        $this->assertLessThanOrEqual(7, count($messages));

        remove_all_filters('gds-assistant/max_iterations');
    }

    public function test_multiple_destructive_tools_each_get_a_tool_result(): void
    {
        // Regression: when the LLM emits two destructive tool_use blocks in
        // a single response, the foreach must emit a pending_approval stub
        // for EACH one — otherwise the subsequent Anthropic call fails with
        // "tool_use ids were found without tool_result blocks immediately
        // after". Previously the loop `break`ed on the first one, leaving
        // later tool_use blocks dangling.
        $this->setExpectedIncorrectUsage('WP_Abilities_Registry::get_registered');

        $provider = $this->mockProvider([
            [
                ['type' => 'text', 'text' => 'Deleting both items.'],
                ['type' => 'tool_use', 'id' => 'toolu_a', 'name' => 'test__destructive-tool', 'input' => ['id' => 1]],
                ['type' => 'tool_use', 'id' => 'toolu_b', 'name' => 'test__destructive-tool', 'input' => ['id' => 2]],
            ],
        ]);

        $registry = new ToolRegistry;
        $registry->register($this->mockToolProvider(
            'test__destructive-tool',
            '[DESTRUCTIVE] Deletes stuff',
            ['deleted' => true],
        ));

        // Mark the tool as dangerous so approval kicks in
        add_filter('gds-assistant/tool_risk', fn () => 'dangerous');

        $loop = new MessageLoop($provider, $registry);
        $events = [];
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'Delete both']],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        remove_all_filters('gds-assistant/tool_risk');

        // The final user message must have tool_result blocks for BOTH ids.
        $lastMsg = end($messages);
        $this->assertSame('user', $lastMsg['role']);
        $resultIds = array_values(array_filter(array_map(
            fn ($b) => is_array($b) && ($b['type'] ?? '') === 'tool_result' ? $b['tool_use_id'] ?? null : null,
            $lastMsg['content'],
        )));
        $this->assertContains('toolu_a', $resultIds);
        $this->assertContains('toolu_b', $resultIds);

        // And both should have triggered an approval-required event.
        $approvalIds = array_map(
            fn ($e) => $e[1]['tool_use_id'] ?? null,
            array_filter($events, fn ($e) => $e[0] === 'tool_approval_required'),
        );
        $this->assertContains('toolu_a', $approvalIds);
        $this->assertContains('toolu_b', $approvalIds);
    }

    public function test_token_tracking(): void
    {
        $provider = new class implements LlmProviderInterface
        {
            public function name(): string
            {
                return 'mock';
            }

            public function stream(array $messages, array $tools, callable $onEvent, ?string $systemPrompt = null): array
            {
                $onEvent('usage', ['input_tokens' => 100, 'output_tokens' => 50]);

                return [['type' => 'text', 'text' => 'response']];
            }
        };

        $registry = new ToolRegistry;
        $loop = new MessageLoop($provider, $registry);
        $loop->run([['role' => 'user', 'content' => 'Hi']], fn () => null);

        $this->assertSame(100, $loop->getInputTokens());
        $this->assertSame(50, $loop->getOutputTokens());
    }

    public function test_client_editor_tool_is_delegated_to_the_browser_not_executed(): void
    {
        // The model asks to run a client-executed editor tool.
        $provider = $this->mockProvider([
            [['type' => 'tool_use', 'id' => 'tu_1', 'name' => 'editor__read_selection', 'input' => new \stdClass]],
        ]);
        $loop = new MessageLoop($provider, new ToolRegistry);

        $events = [];
        $messages = $loop->run(
            [['role' => 'user', 'content' => 'rewrite the selection']],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        // A client_tool_call is emitted for the browser to run.
        $calls = array_values(array_filter($events, fn ($e) => $e[0] === 'client_tool_call'));
        $this->assertCount(1, $calls);
        $this->assertSame('tu_1', $calls[0][1]['tool_use_id']);
        $this->assertSame('editor__read_selection', $calls[0][1]['tool_name']);

        // The loop broke leaving a pending_client stub — nothing ran server-side.
        $last = end($messages);
        $this->assertSame('user', $last['role']);
        $stub = json_decode($last['content'][0]['content'], true);
        $this->assertSame('pending_client', $stub['status']);
    }

    public function test_strips_ts_metadata_from_provider_payload_but_keeps_it_in_transcript(): void
    {
        $provider = new class implements LlmProviderInterface
        {
            public array $received = [];

            public function name(): string
            {
                return 'mock';
            }

            public function stream(array $messages, array $tools, callable $onEvent, ?string $systemPrompt = null): array
            {
                $this->received = $messages;
                $onEvent('text_delta', ['text' => 'ok']);
                $onEvent('message_stop', ['stop_reason' => 'end_turn']);

                return [['type' => 'text', 'text' => 'ok']];
            }
        };

        $loop = new MessageLoop($provider, new ToolRegistry);
        $transcript = $loop->run(
            [['role' => 'user', 'content' => 'Hi', 'ts' => 1700000000000]],
            fn () => null,
        );

        // The provider must not receive display metadata — only {role, content}.
        $this->assertSame(['role', 'content'], array_keys($provider->received[0]));
        // …but the returned/persisted transcript keeps the original ts.
        $this->assertSame(1700000000000, $transcript[0]['ts']);
    }

    // ── Token accumulator edge cases ───────────────────────────

    /**
     * Provider that emits a hand-rolled sequence of (type, data) events. The
     * existing mockProvider helper only emits text_delta / tool_use_start /
     * message_stop, which is too coarse for token-accumulator tests.
     *
     * @param  list<array{0: string, 1: array<string, mixed>}>  $events
     */
    private function eventEmittingProvider(array $events): LlmProviderInterface
    {
        return new class($events) implements LlmProviderInterface
        {
            /** @param list<array{0: string, 1: array<string, mixed>}> $events */
            public function __construct(private array $events) {}

            public function name(): string
            {
                return 'fake';
            }

            public function stream(array $messages, array $tools, callable $onEvent, ?string $systemPrompt = null): array
            {
                foreach ($this->events as [$type, $data]) {
                    $onEvent($type, $data);
                }

                // Return one text block so MessageLoop sees content and stops
                // after one iteration.
                return [['type' => 'text', 'text' => 'ok']];
            }
        };
    }

    public function test_token_tracking_accumulates_across_events(): void
    {
        // Multiple usage events in one turn (Anthropic emits an interim
        // message_delta usage AND a final usage). They must sum, not overwrite.
        $provider = $this->eventEmittingProvider([
            ['usage', ['input_tokens' => 1000, 'output_tokens' => 200, 'cache_read_tokens' => 100, 'cache_write_tokens' => 50]],
            ['usage', ['input_tokens' => 200, 'output_tokens' => 50]],
            ['message_stop', ['stop_reason' => 'end_turn']],
        ]);

        $loop = new MessageLoop($provider, new ToolRegistry);
        $loop->run([['role' => 'user', 'content' => 'hi']], fn () => null);

        $this->assertSame(1200, $loop->getInputTokens());
        $this->assertSame(250, $loop->getOutputTokens());
        $this->assertSame(100, $loop->getCacheReadTokens());
        $this->assertSame(50, $loop->getCacheCreationTokens());
    }

    public function test_token_tracking_casts_string_numerics_to_int(): void
    {
        // A provider that JSON-decoded numbers as strings would otherwise
        // silently accumulate to 0 (with `+= ($data[...] ?? 0)` and PHP's
        // surprising arithmetic). The explicit (int) cast pins the
        // behaviour either way — verify it.
        $provider = $this->eventEmittingProvider([
            ['usage', ['input_tokens' => '500', 'output_tokens' => '120']],
            ['message_stop', []],
        ]);

        $loop = new MessageLoop($provider, new ToolRegistry);
        $loop->run([['role' => 'user', 'content' => 'hi']], fn () => null);

        $this->assertSame(500, $loop->getInputTokens());
        $this->assertSame(120, $loop->getOutputTokens());
    }

    public function test_token_tracking_handles_missing_fields(): void
    {
        // Mid-stream usage events carry partial deltas. Missing fields must
        // default to 0 (via `?? 0`) without throwing or zeroing the running
        // total.
        $provider = $this->eventEmittingProvider([
            ['usage', ['input_tokens' => 50]], // no output yet
            ['usage', ['output_tokens' => 30]], // no input update
            ['message_stop', []],
        ]);

        $loop = new MessageLoop($provider, new ToolRegistry);
        $loop->run([['role' => 'user', 'content' => 'hi']], fn () => null);

        $this->assertSame(50, $loop->getInputTokens());
        $this->assertSame(30, $loop->getOutputTokens());
        $this->assertSame(0, $loop->getCacheReadTokens());
        $this->assertSame(0, $loop->getCacheCreationTokens());
    }

    public function test_token_tracking_initial_counters_are_zero(): void
    {
        $provider = $this->eventEmittingProvider([
            ['message_stop', []],
        ]);
        $loop = new MessageLoop($provider, new ToolRegistry);
        $loop->run([['role' => 'user', 'content' => 'hi']], fn () => null);

        $this->assertSame(0, $loop->getInputTokens());
        $this->assertSame(0, $loop->getOutputTokens());
        $this->assertSame(0, $loop->getCacheReadTokens());
        $this->assertSame(0, $loop->getCacheCreationTokens());
    }

    public function test_user_callback_still_receives_usage_events(): void
    {
        // The accumulator wraps the user-supplied callback. It must NOT
        // swallow events — only intercept usage payloads. The downstream
        // budget reporter consumes the usage events directly.
        $provider = $this->eventEmittingProvider([
            ['text_delta', ['text' => 'hi']],
            ['usage', ['input_tokens' => 10]],
            ['text_delta', ['text' => ' there']],
            ['message_stop', []],
        ]);

        $loop = new MessageLoop($provider, new ToolRegistry);
        $seen = [];
        $loop->run([['role' => 'user', 'content' => 'hi']], function (string $type, array $data) use (&$seen) {
            $seen[] = [$type, $data];
        });

        $types = array_column($seen, 0);
        $this->assertContains('text_delta', $types);
        $this->assertContains('usage', $types);
        $this->assertContains('message_stop', $types);
        // Usage events get accumulated AND forwarded — nothing is dropped.
        $this->assertSame(10, $loop->getInputTokens());
    }
}
