<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\SystemPrompt;
use GeneroWP\Assistant\Tests\TestCase;

class SystemPromptCacheTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        SystemPrompt::bustCache();
    }

    protected function tearDown(): void
    {
        SystemPrompt::bustCache();
        parent::tearDown();
    }

    public function test_build_returns_string(): void
    {
        $prompt = SystemPrompt::build();
        $this->assertIsString($prompt);
        $this->assertNotEmpty($prompt);
    }

    public function test_build_is_cached(): void
    {
        $first = SystemPrompt::build();
        $second = SystemPrompt::build();
        $this->assertSame($first, $second);
    }

    public function test_bust_cache_forces_rebuild(): void
    {
        $first = SystemPrompt::build();

        // Modify the custom prompt option
        update_option('gds_assistant_custom_prompt', 'test custom prompt '.time());
        SystemPrompt::bustCache();

        $second = SystemPrompt::build();
        $this->assertNotSame($first, $second);

        // Clean up
        delete_option('gds_assistant_custom_prompt');
    }

    public function test_includes_custom_prompt(): void
    {
        update_option('gds_assistant_custom_prompt', 'Always respond in Finnish');
        SystemPrompt::bustCache();

        $prompt = SystemPrompt::build();
        $this->assertStringContainsString('Always respond in Finnish', $prompt);

        delete_option('gds_assistant_custom_prompt');
    }

    public function test_includes_memory_entries(): void
    {
        $postId = self::factory()->post->create([
            'post_type' => 'assistant_memory',
            'post_title' => 'Test memory entry',
            'post_content' => 'Products use gds-product CPT',
            'post_status' => 'publish',
        ]);

        SystemPrompt::bustCache();
        $prompt = SystemPrompt::build();

        $this->assertStringContainsString('Test memory entry', $prompt);
        $this->assertStringContainsString('Products use gds-product CPT', $prompt);

        wp_delete_post($postId, true);
    }

    public function test_auto_memory_instruction_when_enabled(): void
    {
        update_option('gds_assistant_auto_memory', true);
        SystemPrompt::bustCache();

        $prompt = SystemPrompt::build();
        $this->assertStringContainsString('memory', $prompt);

        delete_option('gds_assistant_auto_memory');
    }

    public function test_filter_modifies_prompt(): void
    {
        add_filter('gds-assistant/system_prompt', function ($prompt) {
            return $prompt."\n\nCustom filter addition.";
        });

        SystemPrompt::bustCache();
        $prompt = SystemPrompt::build();
        $this->assertStringContainsString('Custom filter addition.', $prompt);

        remove_all_filters('gds-assistant/system_prompt');
    }
}
