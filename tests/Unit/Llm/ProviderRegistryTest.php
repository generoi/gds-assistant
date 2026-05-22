<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\CoreAiProvider;
use GeneroWP\Assistant\Llm\ProviderRegistry;
use WP_UnitTestCase;

class ProviderRegistryTest extends WP_UnitTestCase
{
    public function test_get_models_for_frontend_structure(): void
    {
        $data = ProviderRegistry::getModelsForFrontend();

        $this->assertArrayHasKey('providers', $data);
        $this->assertArrayHasKey('default', $data);
        $this->assertArrayHasKey('pricing', $data);
        $this->assertIsArray($data['providers']);
        $this->assertIsArray($data['pricing']);
        $this->assertArrayHasKey('wordpress:auto', $data['pricing']);
    }

    public function test_legacy_model_keys_map_to_wordpress_provider_when_available(): void
    {
        if (! ProviderRegistry::hasAnyProvider()) {
            $this->markTestSkipped('WordPress AI Client text generation is unavailable.');
        }

        $resolved = ProviderRegistry::resolve('anthropic:sonnet');

        $this->assertNotNull($resolved);
        $this->assertInstanceOf(CoreAiProvider::class, $resolved['provider']);
        $this->assertSame('capable', $resolved['modelId']);
    }

    public function test_unknown_model_key_falls_back_to_wordpress_auto_when_available(): void
    {
        if (! ProviderRegistry::hasAnyProvider()) {
            $this->markTestSkipped('WordPress AI Client text generation is unavailable.');
        }

        $resolved = ProviderRegistry::resolve('nonexistent:model');

        $this->assertNotNull($resolved);
        $this->assertInstanceOf(CoreAiProvider::class, $resolved['provider']);
        $this->assertSame('auto', $resolved['modelId']);
    }

    public function test_pricing_filter(): void
    {
        add_filter('gds-assistant/model_pricing', function ($pricing) {
            $pricing['test:model'] = [1.0, 5.0];

            return $pricing;
        });

        $data = ProviderRegistry::getModelsForFrontend();
        $this->assertArrayHasKey('test:model', $data['pricing']);
        $this->assertEquals([1.0, 5.0], $data['pricing']['test:model']);

        remove_all_filters('gds-assistant/model_pricing');
    }
}
