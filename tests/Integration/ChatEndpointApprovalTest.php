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
}
