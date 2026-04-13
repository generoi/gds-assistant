<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\MemoryToolProvider;
use GeneroWP\Assistant\Tests\TestCase;

class MemoryToolProviderTest extends TestCase
{
    private MemoryToolProvider $provider;

    protected function setUp(): void
    {
        parent::setUp();
        wp_set_current_user($this->createEditorUser());
        $this->provider = new MemoryToolProvider;
    }

    public function test_get_tools_returns_three_tools(): void
    {
        $tools = $this->provider->getTools();

        $this->assertCount(3, $tools);
        $names = array_column($tools, 'name');
        $this->assertContains('assistant__memory-list', $names);
        $this->assertContains('assistant__memory-save', $names);
        $this->assertContains('assistant__memory-forget', $names);
    }

    public function test_handles_memory_prefix(): void
    {
        $this->assertTrue($this->provider->handles('assistant__memory-list'));
        $this->assertFalse($this->provider->handles('assistant__skills-list'));
    }

    public function test_save_memory(): void
    {
        $result = $this->provider->executeTool('assistant__memory-save', [
            'title' => 'Site has 3 languages',
            'content' => 'Finnish (default), English, Swedish',
        ]);

        $this->assertIsArray($result);
        $this->assertArrayHasKey('id', $result);
        $this->assertStringContainsString('Memory saved', $result['message']);

        // Verify post meta
        $source = get_post_meta($result['id'], '_memory_source', true);
        $this->assertEquals('auto', $source);

        wp_delete_post($result['id'], true);
    }

    public function test_save_memory_requires_title_and_content(): void
    {
        $result = $this->provider->executeTool('assistant__memory-save', [
            'title' => '',
            'content' => '',
        ]);

        $this->assertWPError($result);
    }

    public function test_save_memory_enforces_length_limits(): void
    {
        $result = $this->provider->executeTool('assistant__memory-save', [
            'title' => 'Valid title',
            'content' => str_repeat('x', 5001),
        ]);

        $this->assertWPError($result);
    }

    public function test_list_memories(): void
    {
        $postId = wp_insert_post([
            'post_type' => 'assistant_memory',
            'post_title' => 'Test Memory',
            'post_content' => 'Some fact',
            'post_status' => 'publish',
        ]);

        $result = $this->provider->executeTool('assistant__memory-list', []);

        $this->assertIsArray($result);
        $found = false;
        foreach ($result as $memory) {
            if ($memory['title'] === 'Test Memory') {
                $found = true;
                break;
            }
        }
        $this->assertTrue($found);

        wp_delete_post($postId, true);
    }

    public function test_forget_memory(): void
    {
        $postId = wp_insert_post([
            'post_type' => 'assistant_memory',
            'post_title' => 'To Delete',
            'post_content' => 'Will be removed',
            'post_status' => 'publish',
        ]);

        $result = $this->provider->executeTool('assistant__memory-forget', ['id' => $postId]);

        $this->assertIsArray($result);
        $this->assertTrue($result['deleted']);
        $this->assertNull(get_post($postId));
    }

    public function test_forget_nonexistent_memory(): void
    {
        $result = $this->provider->executeTool('assistant__memory-forget', ['id' => 99999]);

        $this->assertWPError($result);
    }

    public function test_permission_check(): void
    {
        wp_set_current_user(self::factory()->user->create(['role' => 'subscriber']));

        $result = $this->provider->executeTool('assistant__memory-list', []);

        $this->assertWPError($result);
        $this->assertEquals('forbidden', $result->get_error_code());
    }

    public function test_sanitizes_input(): void
    {
        $result = $this->provider->executeTool('assistant__memory-save', [
            'title' => '<script>alert("xss")</script>Valid Title',
            'content' => '<p>Some <b>bold</b> content</p>',
        ]);

        $this->assertIsArray($result);
        $post = get_post($result['id']);
        // Title should be sanitized (no script tags)
        $this->assertStringNotContainsString('<script>', $post->post_title);

        wp_delete_post($result['id'], true);
    }
}
