<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Llm\ProviderRegistry;
use GeneroWP\Assistant\Tests\TestCase;

class ToolRestrictionTest extends TestCase
{
    public function test_resolve_returns_tier(): void
    {
        if (! ProviderRegistry::hasAnyProvider()) {
            $this->markTestSkipped('No provider configured.');
        }

        $default = ProviderRegistry::getDefaultModelKey();
        $resolved = ProviderRegistry::resolve($default);

        $this->assertNotNull($resolved);
        $this->assertArrayHasKey('tier', $resolved);
        $this->assertContains($resolved['tier'], ['read', 'standard', 'full']);
    }

    public function test_all_models_have_tier(): void
    {
        if (! ProviderRegistry::hasAnyProvider()) {
            $this->markTestSkipped('No provider configured.');
        }

        $data = ProviderRegistry::getModelsForFrontend();
        $checked = 0;

        foreach ($data['providers'] as $provider) {
            foreach ($provider['models'] as $model) {
                $key = $model['value'];
                $resolved = ProviderRegistry::resolve($key);
                if ($resolved) {
                    $this->assertArrayHasKey('tier', $resolved, "Model {$key} missing tier");
                    $this->assertContains($resolved['tier'], ['read', 'standard', 'full'], "Model {$key} has invalid tier");
                    $checked++;
                }
            }
        }

        $this->assertGreaterThan(0, $checked);
    }

    public function test_filter_applies_to_tools_hook(): void
    {
        $tools = [
            ['name' => 'gds__content-list', 'description' => '[READ-ONLY] List content'],
            ['name' => 'gds__cache-clear', 'description' => '[DESTRUCTIVE] Clear cache'],
        ];

        // Simulate what ChatEndpoint does
        $modelTier = 'read';
        add_filter('gds-assistant/tools', fn (array $t) => ToolRestrictor::filter($t, $modelTier));

        $filtered = apply_filters('gds-assistant/tools', $tools);

        // Read tier should only have safe tools
        $names = array_column($filtered, 'name');
        $this->assertContains('gds__content-list', $names);
        $this->assertNotContains('gds__cache-clear', $names);

        remove_all_filters('gds-assistant/tools');
    }

    public function test_custom_risk_level_override(): void
    {
        add_filter('gds-assistant/tool_risk_level', function ($risk, $tool) {
            if ($tool['name'] === 'gds__cache-clear') {
                return 'safe'; // Downgrade risk for testing
            }

            return $risk;
        }, 10, 2);

        $tools = [
            ['name' => 'gds__cache-clear', 'description' => '[DESTRUCTIVE] Clear cache'],
        ];

        // Even with 'read' tier, the overridden tool should pass
        $filtered = ToolRestrictor::filter($tools, 'read');
        $this->assertCount(1, $filtered);

        remove_all_filters('gds-assistant/tool_risk_level');
    }
}
