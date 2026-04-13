<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Tests\TestCase;

class ToolRestrictorTest extends TestCase
{
    private array $tools;

    protected function setUp(): void
    {
        parent::setUp();

        $this->tools = [
            ['name' => 'gds__content-list', 'description' => '[READ-ONLY] List content'],
            ['name' => 'gds__content-read', 'description' => '[READ-ONLY] Read content'],
            ['name' => 'gds__content-create', 'description' => 'Create content'],
            ['name' => 'gds__content-update', 'description' => 'Update content'],
            ['name' => 'gds__content-delete', 'description' => 'Delete content'],
            ['name' => 'gds__terms-list', 'description' => '[READ-ONLY] List terms'],
            ['name' => 'gds__terms-create', 'description' => 'Create terms'],
            ['name' => 'gds__terms-update', 'description' => 'Update terms'],
            ['name' => 'gds__terms-delete', 'description' => '[DESTRUCTIVE] Delete terms'],
            ['name' => 'gds__cache-clear', 'description' => '[DESTRUCTIVE] Clear cache'],
            ['name' => 'gds__menus-add-item', 'description' => 'Add menu item'],
            ['name' => 'gds__forms-create', 'description' => 'Create form'],
            ['name' => 'assistant__skills-list', 'description' => 'List skills'],
            ['name' => 'assistant__memory-save', 'description' => 'Save memory'],
        ];
    }

    public function test_full_tier_returns_all_tools(): void
    {
        $filtered = ToolRestrictor::filter($this->tools, 'full');
        $this->assertCount(count($this->tools), $filtered);
    }

    public function test_read_tier_allows_readonly_and_reversible(): void
    {
        $filtered = ToolRestrictor::filter($this->tools, 'read');
        $names = array_column($filtered, 'name');

        // Safe: read-only
        $this->assertContains('gds__content-list', $names);
        $this->assertContains('gds__content-read', $names);
        $this->assertContains('gds__terms-list', $names);

        // Safe: content writes (revisions exist)
        $this->assertContains('gds__content-create', $names);
        $this->assertContains('gds__content-update', $names);

        // Safe: internal assistant tools
        $this->assertContains('assistant__skills-list', $names);
        $this->assertContains('assistant__memory-save', $names);

        // Blocked: moderate
        $this->assertNotContains('gds__content-delete', $names);
        $this->assertNotContains('gds__terms-create', $names);
        $this->assertNotContains('gds__terms-update', $names);
        $this->assertNotContains('gds__menus-add-item', $names);
        $this->assertNotContains('gds__forms-create', $names);

        // Blocked: dangerous
        $this->assertNotContains('gds__terms-delete', $names);
        $this->assertNotContains('gds__cache-clear', $names);
    }

    public function test_standard_tier_allows_safe_and_moderate(): void
    {
        $filtered = ToolRestrictor::filter($this->tools, 'standard');
        $names = array_column($filtered, 'name');

        // Allowed: safe
        $this->assertContains('gds__content-list', $names);
        $this->assertContains('gds__content-create', $names);

        // Allowed: moderate
        $this->assertContains('gds__content-delete', $names);
        $this->assertContains('gds__terms-create', $names);
        $this->assertContains('gds__menus-add-item', $names);
        $this->assertContains('gds__forms-create', $names);

        // Blocked: dangerous
        $this->assertNotContains('gds__terms-delete', $names);
        $this->assertNotContains('gds__cache-clear', $names);
    }

    public function test_assistant_tools_always_pass(): void
    {
        foreach (['read', 'standard', 'full'] as $tier) {
            $filtered = ToolRestrictor::filter($this->tools, $tier);
            $names = array_column($filtered, 'name');

            $this->assertContains('assistant__skills-list', $names, "Skills should pass in {$tier} tier");
            $this->assertContains('assistant__memory-save', $names, "Memory should pass in {$tier} tier");
        }
    }

    public function test_classify_risk_read_only_annotation(): void
    {
        $this->assertSame('safe', ToolRestrictor::classifyRisk([
            'name' => 'gds__anything-list',
            'description' => '[READ-ONLY] Some tool',
        ]));
    }

    public function test_classify_risk_destructive_annotation(): void
    {
        $this->assertSame('dangerous', ToolRestrictor::classifyRisk([
            'name' => 'gds__anything-delete',
            'description' => '[DESTRUCTIVE] Some tool',
        ]));
    }

    public function test_classify_risk_content_update_is_safe(): void
    {
        $this->assertSame('safe', ToolRestrictor::classifyRisk([
            'name' => 'gds__content-update',
            'description' => 'Update content',
        ]));
    }

    public function test_classify_risk_terms_update_is_moderate(): void
    {
        $this->assertSame('moderate', ToolRestrictor::classifyRisk([
            'name' => 'gds__terms-update',
            'description' => 'Update terms',
        ]));
    }

    public function test_risk_level_filter(): void
    {
        add_filter('gds-assistant/tool_risk_level', function ($risk, $tool) {
            // Override: make forms-create safe (hypothetical custom logic)
            if ($tool['name'] === 'gds__forms-create') {
                return 'safe';
            }

            return $risk;
        }, 10, 2);

        $this->assertSame('safe', ToolRestrictor::classifyRisk([
            'name' => 'gds__forms-create',
            'description' => 'Create form',
        ]));

        remove_all_filters('gds-assistant/tool_risk_level');
    }
}
