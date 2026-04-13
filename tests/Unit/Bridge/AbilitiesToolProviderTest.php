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

    public function test_handles_gds_prefixed_names(): void
    {
        $this->assertTrue($this->provider->handles('gds__posts-list'));
        $this->assertTrue($this->provider->handles('gds__help'));
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

    public function test_skips_non_gds_abilities(): void
    {
        $tools = $this->provider->getTools();
        if (empty($tools)) {
            $this->markTestSkipped('No tools registered (gds-mcp not loaded).');
        }
        foreach ($tools as $tool) {
            $this->assertStringStartsWith('gds__', $tool['name']);
        }
    }
}
