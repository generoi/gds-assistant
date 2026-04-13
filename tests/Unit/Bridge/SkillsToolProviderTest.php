<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\SkillsToolProvider;
use GeneroWP\Assistant\Tests\TestCase;

class SkillsToolProviderTest extends TestCase
{
    private SkillsToolProvider $provider;

    protected function setUp(): void
    {
        parent::setUp();
        wp_set_current_user($this->createEditorUser());
        $this->provider = new SkillsToolProvider;
    }

    public function test_get_tools_returns_three_tools(): void
    {
        $tools = $this->provider->getTools();

        $this->assertCount(3, $tools);
        $names = array_column($tools, 'name');
        $this->assertContains('assistant__skills-list', $names);
        $this->assertContains('assistant__skills-create', $names);
        $this->assertContains('assistant__skills-update', $names);
    }

    public function test_handles_skills_prefix(): void
    {
        $this->assertTrue($this->provider->handles('assistant__skills-list'));
        $this->assertTrue($this->provider->handles('assistant__skills-create'));
        $this->assertFalse($this->provider->handles('assistant__memory-list'));
        $this->assertFalse($this->provider->handles('gds__posts-list'));
    }

    public function test_create_skill(): void
    {
        $result = $this->provider->executeTool('assistant__skills-create', [
            'title' => 'Test Skill',
            'prompt' => 'Do something useful',
            'description' => 'A test skill',
            'slug' => 'test-skill',
        ]);

        $this->assertIsArray($result);
        $this->assertArrayHasKey('id', $result);
        $this->assertEquals('Test Skill', $result['title']);
        $this->assertStringContainsString('/test-skill', $result['message']);

        // Clean up
        wp_delete_post($result['id'], true);
    }

    public function test_create_skill_requires_title_and_prompt(): void
    {
        $result = $this->provider->executeTool('assistant__skills-create', [
            'title' => '',
            'prompt' => '',
        ]);

        $this->assertWPError($result);
    }

    public function test_create_skill_enforces_length_limits(): void
    {
        $result = $this->provider->executeTool('assistant__skills-create', [
            'title' => str_repeat('x', 201),
            'prompt' => 'Valid prompt',
        ]);

        $this->assertWPError($result);
        $this->assertEquals('invalid_input', $result->get_error_code());
    }

    public function test_list_skills(): void
    {
        // Create a skill first
        $postId = wp_insert_post([
            'post_type' => 'assistant_skill',
            'post_title' => 'Listed Skill',
            'post_content' => 'Some prompt',
            'post_status' => 'publish',
        ]);

        $result = $this->provider->executeTool('assistant__skills-list', []);

        $this->assertIsArray($result);
        $found = false;
        foreach ($result as $skill) {
            if ($skill['title'] === 'Listed Skill') {
                $found = true;
                break;
            }
        }
        $this->assertTrue($found, 'Created skill should appear in list');

        wp_delete_post($postId, true);
    }

    public function test_update_skill(): void
    {
        $postId = wp_insert_post([
            'post_type' => 'assistant_skill',
            'post_title' => 'Original',
            'post_content' => 'Original prompt',
            'post_status' => 'publish',
        ]);

        $result = $this->provider->executeTool('assistant__skills-update', [
            'id' => $postId,
            'title' => 'Updated',
        ]);

        $this->assertIsArray($result);
        $this->assertEquals('Updated', $result['title']);

        wp_delete_post($postId, true);
    }

    public function test_permission_check(): void
    {
        // Switch to a subscriber (no edit_posts capability)
        wp_set_current_user(self::factory()->user->create(['role' => 'subscriber']));

        $result = $this->provider->executeTool('assistant__skills-list', []);

        $this->assertWPError($result);
        $this->assertEquals('forbidden', $result->get_error_code());
    }
}
