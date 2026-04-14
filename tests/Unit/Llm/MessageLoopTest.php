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
}
