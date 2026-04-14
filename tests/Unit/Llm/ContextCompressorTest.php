<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\ContextCompressor;
use WP_UnitTestCase;

class ContextCompressorTest extends WP_UnitTestCase
{
    public function test_no_compression_under_threshold(): void
    {
        $messages = [
            ['role' => 'user', 'content' => 'Hello'],
            ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Hi!']]],
        ];

        $result = ContextCompressor::compress($messages);

        $this->assertSame($messages, $result['messages']);
    }

    public function test_truncates_large_tool_results(): void
    {
        // Create a message with a large tool result
        $largeResult = json_encode(['posts' => array_map(fn ($i) => [
            'id' => $i,
            'title' => ['rendered' => "Page {$i}"],
            'status' => 'publish',
            'content' => ['rendered' => str_repeat('x', 500)],
        ], range(1, 50))]);

        $messages = [
            ['role' => 'user', 'content' => 'List pages'],
            ['role' => 'assistant', 'content' => [
                ['type' => 'text', 'text' => 'Let me list pages'],
                ['type' => 'tool_use', 'id' => 't1', 'name' => 'gds__content-list', 'input' => new \stdClass],
            ]],
            ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 't1', 'content' => $largeResult],
            ]],
        ];

        // Force compression by making it look large
        add_filter('gds-assistant/compression_threshold', fn () => 1);
        $result = ContextCompressor::compress($messages);
        remove_all_filters('gds-assistant/compression_threshold');

        // The tool result should be summarized, not the full JSON
        $compressed = $result['messages'][2]['content'][0]['content'] ?? '';
        $this->assertStringContainsString('Content list', $compressed);
        $this->assertStringContainsString('Page 1', $compressed);
        $this->assertLessThan(strlen($largeResult), strlen($compressed));
    }

    public function test_strips_old_tool_results(): void
    {
        // Build messages that exceed threshold
        $messages = [];
        for ($i = 0; $i < 20; $i++) {
            $messages[] = ['role' => 'user', 'content' => "Message {$i}"];
            $messages[] = ['role' => 'assistant', 'content' => [
                ['type' => 'text', 'text' => "Response {$i}"],
                ['type' => 'tool_use', 'id' => "t{$i}", 'name' => 'gds__test', 'input' => new \stdClass],
            ]];
            $messages[] = ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => "t{$i}", 'content' => str_repeat('data', 500)],
            ]];
        }

        add_filter('gds-assistant/compression_threshold', fn () => 1);
        add_filter('gds-assistant/keep_recent_messages', fn () => 6);
        $result = ContextCompressor::compress($messages);
        remove_all_filters('gds-assistant/compression_threshold');
        remove_all_filters('gds-assistant/keep_recent_messages');

        // Old tool results should be stripped
        $firstToolResult = null;
        foreach ($result['messages'] as $msg) {
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }
            foreach ($msg['content'] as $block) {
                if (($block['type'] ?? '') === 'tool_result') {
                    $firstToolResult = $block['content'];
                    break 2;
                }
            }
        }

        // First tool result should be stripped (placeholder)
        if ($firstToolResult !== null) {
            $this->assertStringContainsString('tool result', strtolower($firstToolResult));
        }
    }

    public function test_estimate_tokens(): void
    {
        $messages = [
            ['role' => 'user', 'content' => str_repeat('x', 400)], // ~100 tokens
        ];

        $tokens = ContextCompressor::estimateTokens($messages);

        // Should be roughly strlen/4
        $this->assertGreaterThan(50, $tokens);
        $this->assertLessThan(200, $tokens);
    }

    public function test_summarize_tool_result_list(): void
    {
        $json = json_encode([
            'posts' => [
                ['id' => 1, 'title' => ['rendered' => 'About'], 'status' => 'publish'],
                ['id' => 2, 'title' => ['rendered' => 'Contact'], 'status' => 'draft'],
            ],
            'total' => 2,
        ]);

        // Use reflection to test private method
        $method = new \ReflectionMethod(ContextCompressor::class, 'summarizeToolResult');
        $method->setAccessible(true);
        $summary = $method->invoke(null, $json);

        $this->assertStringContainsString('2 total', $summary);
        $this->assertStringContainsString('About', $summary);
        $this->assertStringContainsString('Contact', $summary);
    }

    public function test_summarize_tool_result_single_item(): void
    {
        $json = json_encode([
            'id' => 42,
            'title' => ['rendered' => 'My Page'],
            'status' => 'publish',
            'type' => 'page',
        ]);

        $method = new \ReflectionMethod(ContextCompressor::class, 'summarizeToolResult');
        $method->setAccessible(true);
        $summary = $method->invoke(null, $json);

        $this->assertStringContainsString('42', $summary);
        $this->assertStringContainsString('My Page', $summary);
        $this->assertStringContainsString('page', $summary);
    }

    public function test_build_turn_summary(): void
    {
        $messages = [
            ['role' => 'user', 'content' => 'Create a draft page called Test'],
            ['role' => 'assistant', 'content' => [
                ['type' => 'tool_use', 'id' => 't1', 'name' => 'gds__content-create', 'input' => []],
                ['type' => 'text', 'text' => 'Created page ID 123.'],
            ]],
        ];

        $summary = ContextCompressor::buildTurnSummary($messages);

        $this->assertStringContainsString('Create a draft page', $summary);
        $this->assertStringContainsString('content-create', $summary);
        $this->assertStringContainsString('Created page', $summary);
    }

    public function test_estimate_tokens_strips_image_data(): void
    {
        $withImage = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                    ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => str_repeat('A', 100000)]],
                ],
            ],
        ];

        $withoutImage = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                ],
            ],
        ];

        $tokensWithImage = ContextCompressor::estimateTokens($withImage);
        $tokensWithoutImage = ContextCompressor::estimateTokens($withoutImage);

        // Image should add ~1500 tokens, not 25000 (100KB/4)
        $diff = $tokensWithImage - $tokensWithoutImage;
        $this->assertGreaterThan(1000, $diff); // At least the image token estimate
        $this->assertLessThan(5000, $diff); // But not the raw base64 size
    }

    public function test_strip_old_images(): void
    {
        $messages = [
            ['role' => 'user', 'content' => [
                ['type' => 'text', 'text' => 'Old message'],
                ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => 'old_data']],
            ]],
            ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'I see the image.']]],
            ['role' => 'user', 'content' => [
                ['type' => 'text', 'text' => 'Recent message'],
                ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => 'new_data']],
            ]],
            ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Got it.']]],
        ];

        $stripped = ContextCompressor::stripOldImages($messages, 2);

        // Old image (index 0) should be replaced with placeholder text
        $oldContent = $stripped[0]['content'];
        $hasImage = false;
        foreach ($oldContent as $block) {
            if (($block['type'] ?? '') === 'image') {
                $hasImage = true;
            }
        }
        $this->assertFalse($hasImage, 'Old image should be stripped');

        // Recent image (index 2) should be preserved (within keepRecent)
        $newContent = $stripped[2]['content'];
        $hasImage = false;
        foreach ($newContent as $block) {
            if (($block['type'] ?? '') === 'image') {
                $hasImage = true;
            }
        }
        $this->assertTrue($hasImage, 'Recent image should be preserved');
    }
}
