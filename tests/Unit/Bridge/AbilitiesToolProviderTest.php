<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\AbilitiesToolProvider;
use GeneroWP\Assistant\Tests\TestCase;

class AbilitiesToolProviderTest extends TestCase
{
    private AbilitiesToolProvider $provider;

    protected function setUp(): void
    {
        parent::setUp();
        wp_set_current_user($this->createEditorUser());
        $this->provider = new AbilitiesToolProvider;
    }

    public function test_get_tools_returns_array(): void
    {
        $tools = $this->provider->getTools();
        $this->assertIsArray($tools);
    }

    public function test_tools_have_required_fields(): void
    {
        if (! function_exists('wp_get_abilities')) {
            $this->markTestSkipped('WP Abilities API not available.');
        }

        $tools = $this->provider->getTools();
        if (empty($tools)) {
            $this->markTestSkipped('No tools registered (gds-mcp not loaded).');
        }

        foreach ($tools as $tool) {
            $this->assertArrayHasKey('name', $tool);
            $this->assertArrayHasKey('description', $tool);
            $this->assertArrayHasKey('input_schema', $tool);
            $this->assertArrayHasKey('type', $tool['input_schema']);
        }
    }

    public function test_tool_names_use_double_underscore(): void
    {
        $tools = $this->provider->getTools();
        if (empty($tools)) {
            $this->markTestSkipped('No tools registered (gds-mcp not loaded).');
        }
        foreach ($tools as $tool) {
            $this->assertStringNotContainsString('/', $tool['name'], "Tool name should not contain /: {$tool['name']}");
        }
    }

    public function test_handles_only_tools_in_catalog(): void
    {
        $tools = $this->provider->getTools();
        if (empty($tools)) {
            $this->markTestSkipped('No tools registered (gds-mcp not loaded).');
        }
        // Anything in the catalog is handled — anything else is not.
        $this->assertTrue($this->provider->handles($tools[0]['name']));
        $this->assertFalse($this->provider->handles('other__posts-list'));
        $this->assertFalse($this->provider->handles('random-tool'));
    }

    public function test_name_conversion_roundtrip(): void
    {
        $abilityName = 'gds/posts-list';
        $toolName = AbilitiesToolProvider::toToolName($abilityName);
        $this->assertEquals('gds__posts-list', $toolName);

        $backToAbility = AbilitiesToolProvider::toAbilityName($toolName);
        $this->assertEquals($abilityName, $backToAbility);
    }

    public function test_execute_returns_error_for_unknown_tool(): void
    {
        // wp_get_ability() triggers a _doing_it_wrong notice for missing abilities
        $this->setExpectedIncorrectUsage('WP_Abilities_Registry::get_registered');

        $result = $this->provider->executeTool('gds__nonexistent-tool', []);
        $this->assertWPError($result);
    }

    public function test_includes_only_mcp_public_abilities(): void
    {
        $tools = $this->provider->getTools();
        if (empty($tools)) {
            $this->markTestSkipped('No tools registered (gds-mcp not loaded).');
        }
        foreach ($tools as $tool) {
            // Tool name is the LLM-safe form (gds__posts-list); convert back
            // to the ability name and assert the source ability is mcp.public.
            $abilityName = AbilitiesToolProvider::toAbilityName($tool['name']);
            $ability = wp_get_ability($abilityName);
            $this->assertNotNull($ability, "Ability {$abilityName} should be registered");
            $meta = $ability->get_meta();
            $this->assertNotEmpty(
                $meta['mcp']['public'] ?? null,
                "Ability {$abilityName} should have mcp.public=true"
            );
        }
    }
}
