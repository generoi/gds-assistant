<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Api\ChatEndpoint;
use GeneroWP\Assistant\Plugin;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class ChatEndpointApprovalTest extends TestCase
{
    private ChatEndpoint $endpoint;

    private ReflectionMethod $detectToolApproval;

    private ReflectionMethod $handleToolApproval;

    protected function setUp(): void
    {
        parent::setUp();
        $this->endpoint = new ChatEndpoint(Plugin::getInstance());
        $this->detectToolApproval = new ReflectionMethod(ChatEndpoint::class, 'detectToolApproval');
        $this->detectToolApproval->setAccessible(true);
        $this->handleToolApproval = new ReflectionMethod(ChatEndpoint::class, 'handleToolApproval');
        $this->handleToolApproval->setAccessible(true);
    }

    public function test_detect_approval_message(): void
    {
        $messages = [
            ['role' => 'user', 'content' => '__tool_approved__:toolu_abc123'],
        ];

        $result = $this->detectToolApproval->invoke($this->endpoint, $messages);
        $this->assertNotNull($result);
        $this->assertSame('toolu_abc123', $result[0]);
        $this->assertTrue($result[1]);
    }

    public function test_detect_denial_message(): void
    {
        $messages = [
            ['role' => 'user', 'content' => '__tool_denied__:toolu_abc123'],
        ];

        $result = $this->detectToolApproval->invoke($this->endpoint, $messages);
        $this->assertNotNull($result);
        $this->assertSame('toolu_abc123', $result[0]);
        $this->assertFalse($result[1]);
    }

    public function test_detect_normal_message_returns_null(): void
    {
        $messages = [
            ['role' => 'user', 'content' => 'Just a normal message'],
        ];

        $result = $this->detectToolApproval->invoke($this->endpoint, $messages);
        $this->assertNull($result);
    }

    public function test_detect_empty_messages_returns_null(): void
    {
        $result = $this->detectToolApproval->invoke($this->endpoint, []);
        $this->assertNull($result);
    }

    public function test_detect_array_content_returns_null(): void
    {
        $messages = [
            ['role' => 'user', 'content' => [['type' => 'text', 'text' => 'Hello']]],
        ];

        $result = $this->detectToolApproval->invoke($this->endpoint, $messages);
        $this->assertNull($result);
    }

    public function test_denial_injects_error_result(): void
    {
        $storedMessages = [
            ['role' => 'user', 'content' => 'Delete the cache'],
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'text', 'text' => 'I will clear the cache.'],
                    ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'gds__cache-clear', 'input' => new \stdClass],
                ],
            ],
            [
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'tool_result',
                        'tool_use_id' => 'toolu_1',
                        'content' => json_encode(['status' => 'pending_approval']),
                        'is_error' => false,
                    ],
                ],
            ],
        ];

        $events = [];
        $result = $this->handleToolApproval->invokeArgs($this->endpoint, [
            $storedMessages,
            'toolu_1',
            false, // denied
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        ]);

        // Should emit tool_result with error
        $this->assertCount(1, $events);
        $this->assertSame('tool_result', $events[0][0]);
        $this->assertTrue($events[0][1]['is_error']);
        $this->assertStringContainsString('denied', json_encode($events[0][1]['result']));

        // The pending_approval result should be replaced with error
        $lastMsg = end($result);
        $toolResult = $lastMsg['content'][0];
        $this->assertTrue($toolResult['is_error']);
        $decoded = json_decode($toolResult['content'], true);
        $this->assertStringContainsString('denied', $decoded['error']);
    }

    public function test_approval_with_unknown_tool_id(): void
    {
        $storedMessages = [
            ['role' => 'user', 'content' => 'Do something'],
        ];

        $events = [];
        $result = $this->handleToolApproval->invokeArgs($this->endpoint, [
            $storedMessages,
            'nonexistent_id',
            true,
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        ]);

        // Should emit denial-style result since tool wasn't found
        $this->assertCount(1, $events);
        $this->assertTrue($events[0][1]['is_error']);
    }

    public function test_single_deny_batch_resolves_all_pending(): void
    {
        // Regression: user sees 2 pending-approval prompts but clicks Deny
        // once. Both tool_results must transition to error state — otherwise
        // the second one stays pending_approval forever.
        $storedMessages = [
            ['role' => 'user', 'content' => 'Delete both items'],
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'text', 'text' => 'Sure.'],
                    ['type' => 'tool_use', 'id' => 'toolu_a', 'name' => 'gds__content-delete', 'input' => ['id' => 1]],
                    ['type' => 'tool_use', 'id' => 'toolu_b', 'name' => 'gds__content-delete', 'input' => ['id' => 2]],
                ],
            ],
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_a', 'content' => json_encode(['status' => 'pending_approval']), 'is_error' => false],
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_b', 'content' => json_encode(['status' => 'pending_approval']), 'is_error' => false],
                ],
            ],
        ];

        $events = [];
        $result = $this->handleToolApproval->invokeArgs($this->endpoint, [
            $storedMessages,
            'toolu_a',
            false, // deny
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        ]);

        // Should emit tool_result events for BOTH ids
        $ids = array_map(fn ($e) => $e[1]['tool_use_id'] ?? null, $events);
        $this->assertContains('toolu_a', $ids);
        $this->assertContains('toolu_b', $ids);

        // And stored messages should have both denied
        $lastMsg = end($result);
        foreach ($lastMsg['content'] as $block) {
            $this->assertTrue($block['is_error'], "Expected tool_result for {$block['tool_use_id']} to be error");
            $decoded = json_decode($block['content'], true);
            $this->assertStringContainsString('denied', $decoded['error'] ?? '');
        }
    }

    public function test_resurface_pending_approvals_emits_events(): void
    {
        $resurface = new ReflectionMethod(ChatEndpoint::class, 'resurfacePendingApprovals');
        $resurface->setAccessible(true);

        $storedMessages = [
            ['role' => 'user', 'content' => [['type' => 'text', 'text' => 'Delete both']]],
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'tool_use', 'id' => 'toolu_x', 'name' => 'gds__content-delete', 'input' => ['id' => 1]],
                    ['type' => 'tool_use', 'id' => 'toolu_y', 'name' => 'gds__content-delete', 'input' => ['id' => 2]],
                ],
            ],
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_x', 'content' => json_encode(['status' => 'pending_approval']), 'is_error' => false],
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_y', 'content' => json_encode(['status' => 'pending_approval']), 'is_error' => false],
                ],
            ],
        ];

        $events = [];
        $resurface->invokeArgs($this->endpoint, [
            $storedMessages,
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        ]);

        $this->assertCount(2, $events);
        $ids = array_map(fn ($e) => $e[1]['tool_use_id'], $events);
        $this->assertContains('toolu_x', $ids);
        $this->assertContains('toolu_y', $ids);
        foreach ($events as $e) {
            $this->assertSame('tool_approval_required', $e[0]);
        }
    }

    public function test_resurface_ignores_already_resolved_tools(): void
    {
        $resurface = new ReflectionMethod(ChatEndpoint::class, 'resurfacePendingApprovals');
        $resurface->setAccessible(true);

        $storedMessages = [
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'tool_use', 'id' => 'toolu_done', 'name' => 'gds__content-delete', 'input' => []],
                ],
            ],
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_done', 'content' => json_encode(['deleted' => true]), 'is_error' => false],
                ],
            ],
        ];

        $events = [];
        $resurface->invokeArgs($this->endpoint, [
            $storedMessages,
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        ]);

        // No pending_approval stubs → no events
        $this->assertCount(0, $events);
    }

    public function test_sanitize_patches_dangling_tool_use(): void
    {
        // Defensive fix: older versions could persist an assistant message
        // with tool_use blocks but no matching tool_result in the next user
        // message (e.g. mid-turn crash, or the original break-before-paired-
        // result bug). sanitizeMessages now injects synthetic skipped-result
        // blocks so the conversation replays cleanly.
        $sanitize = new ReflectionMethod(ChatEndpoint::class, 'sanitizeMessages');
        $sanitize->setAccessible(true);

        $messages = [
            ['role' => 'user', 'content' => 'Delete stuff'],
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'tool_use', 'id' => 'toolu_a', 'name' => 'gds__content-delete', 'input' => ['id' => 1]],
                    ['type' => 'tool_use', 'id' => 'toolu_b', 'name' => 'gds__content-delete', 'input' => ['id' => 2]],
                ],
            ],
            // Only A has a result — B is dangling
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_a', 'content' => '{}', 'is_error' => false],
                ],
            ],
        ];

        $patched = $sanitize->invokeArgs(null, [$messages]);

        // After sanitization, the user message should have BOTH tool_results
        $userMsg = $patched[2];
        $this->assertSame('user', $userMsg['role']);
        $ids = array_map(fn ($b) => $b['tool_use_id'] ?? null, $userMsg['content']);
        $this->assertContains('toolu_a', $ids);
        $this->assertContains('toolu_b', $ids);

        // B's synthetic result should be marked error
        $b = array_values(array_filter($userMsg['content'], fn ($b) => ($b['tool_use_id'] ?? '') === 'toolu_b'))[0];
        $this->assertTrue($b['is_error']);
    }

    public function test_sanitize_injects_user_message_if_next_is_assistant(): void
    {
        // Pathological case: assistant with tool_use followed by ANOTHER
        // assistant message (no user msg in between). Sanitizer must insert
        // a fresh user message with the skipped stub so the sequence is valid.
        $sanitize = new ReflectionMethod(ChatEndpoint::class, 'sanitizeMessages');
        $sanitize->setAccessible(true);

        $messages = [
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'tool_use', 'id' => 'toolu_x', 'name' => 'gds__content-delete', 'input' => []],
                ],
            ],
            [
                'role' => 'assistant',
                'content' => [['type' => 'text', 'text' => 'oops next assistant']],
            ],
        ];

        $patched = $sanitize->invokeArgs(null, [$messages]);

        $this->assertCount(3, $patched);
        $this->assertSame('user', $patched[1]['role']);
        $this->assertSame('toolu_x', $patched[1]['content'][0]['tool_use_id']);
    }
}
