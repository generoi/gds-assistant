<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\LlmProviderInterface;
use GeneroWP\Assistant\Llm\SmartProvider;
use GeneroWP\Assistant\Tests\TestCase;

class SmartProviderTest extends TestCase
{
    public function test_uses_full_provider_for_user_text(): void
    {
        $cheap = $this->createProviderMock('cheap');
        $full = $this->createProviderMock('full');

        $smart = new SmartProvider($cheap, $full, 'test');

        $messages = [
            ['role' => 'user', 'content' => 'Hello, help me with my site'],
        ];

        // Full provider should be called (user text, not tool results)
        $full->expects($this->once())->method('stream')->willReturn([]);
        $cheap->expects($this->never())->method('stream');

        $smart->stream($messages, [], fn () => null, null);
    }

    public function test_uses_cheap_provider_for_tool_result_turn(): void
    {
        $cheap = $this->createProviderMock('cheap');
        $full = $this->createProviderMock('full');

        $smart = new SmartProvider($cheap, $full, 'test');

        $messages = [
            ['role' => 'user', 'content' => 'List my pages'],
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'gds__posts-list', 'input' => ['type' => 'page']],
                ],
            ],
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'tool_result', 'tool_use_id' => 'toolu_1', 'content' => '{"posts":[]}'],
                ],
            ],
        ];

        // Cheap provider should be called (last user message has tool_result)
        $cheap->expects($this->once())->method('stream')->willReturn([]);
        $full->expects($this->never())->method('stream');

        $smart->stream($messages, [], fn () => null, null);
    }

    public function test_uses_full_provider_when_user_sends_text_after_tools(): void
    {
        $cheap = $this->createProviderMock('cheap');
        $full = $this->createProviderMock('full');

        $smart = new SmartProvider($cheap, $full, 'test');

        // User followed up with text (not a tool_result)
        $messages = [
            ['role' => 'user', 'content' => 'List my pages'],
            [
                'role' => 'assistant',
                'content' => [['type' => 'text', 'text' => 'Here are your pages: ...']],
            ],
            ['role' => 'user', 'content' => 'Now translate the first one'],
        ];

        // Full provider — last user message is plain text
        $full->expects($this->once())->method('stream')->willReturn([]);
        $cheap->expects($this->never())->method('stream');

        $smart->stream($messages, [], fn () => null, null);
    }

    public function test_is_tool_routing_turn_static(): void
    {
        // Tool result turn
        $this->assertTrue(SmartProvider::isToolRoutingTurn([
            ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 'x', 'content' => '{}'],
            ]],
        ]));

        // User text turn
        $this->assertFalse(SmartProvider::isToolRoutingTurn([
            ['role' => 'user', 'content' => 'Hello'],
        ]));

        // Empty messages
        $this->assertFalse(SmartProvider::isToolRoutingTurn([]));

        // Assistant message last (shouldn't happen but handle gracefully)
        $this->assertFalse(SmartProvider::isToolRoutingTurn([
            ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Hi']]],
        ]));
    }

    public function test_name_returns_provider_name(): void
    {
        $cheap = $this->createProviderMock('cheap');
        $full = $this->createProviderMock('full');
        $smart = new SmartProvider($cheap, $full, 'anthropic');

        $this->assertSame('anthropic', $smart->name());
    }

    private function createProviderMock(string $name): LlmProviderInterface
    {
        $mock = $this->createMock(LlmProviderInterface::class);
        $mock->method('name')->willReturn($name);

        return $mock;
    }
}
