<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\SystemPrompt;
use WP_UnitTestCase;

class SystemPromptTest extends WP_UnitTestCase
{
    public function test_build_returns_string(): void
    {
        $prompt = SystemPrompt::build();

        $this->assertIsString($prompt);
        $this->assertNotEmpty($prompt);
    }

    public function test_build_includes_site_name(): void
    {
        $prompt = SystemPrompt::build();
        $siteName = get_bloginfo('name');

        $this->assertStringContainsString($siteName, $prompt);
    }

    public function test_build_includes_post_types(): void
    {
        $prompt = SystemPrompt::build();

        $this->assertStringContainsString('post', $prompt);
        $this->assertStringContainsString('page', $prompt);
    }

    public function test_filter_modifies_prompt(): void
    {
        add_filter('gds-assistant/system_prompt', function ($prompt) {
            return $prompt."\nCustom instruction.";
        });

        $prompt = SystemPrompt::build();

        $this->assertStringContainsString('Custom instruction.', $prompt);

        remove_all_filters('gds-assistant/system_prompt');
    }
}
