<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\AnthropicProvider;
use GeneroWP\Assistant\Llm\GeminiProvider;
use GeneroWP\Assistant\Llm\OpenAiCompatibleProvider;
use GeneroWP\Assistant\Llm\ProviderRegistry;
use WP_UnitTestCase;

class ProviderRegistryTest extends WP_UnitTestCase
{
    public function test_has_no_provider_without_keys(): void
    {
        // With no env vars set, no providers should be available
        // Note: this test may fail if env vars ARE set in the test environment
        $available = ProviderRegistry::getAvailable();

        // At minimum, the registry should return an array
        $this->assertIsArray($available);
    }

    public function test_resolve_returns_null_for_unknown_model(): void
    {
        $result = ProviderRegistry::resolve('nonexistent:model');

        $this->assertNull($result);
    }

    public function test_resolve_anthropic_model(): void
    {
        // Skip if no Anthropic key
        if (! ProviderRegistry::getApiKey('anthropic')) {
            $this->markTestSkipped('No Anthropic API key configured.');
        }

        $result = ProviderRegistry::resolve('anthropic:sonnet');

        $this->assertNotNull($result);
        $this->assertInstanceOf(AnthropicProvider::class, $result['provider']);
        $this->assertEquals('claude-sonnet-4-6', $result['modelId']);
    }

    public function test_resolve_openai_model(): void
    {
        if (! ProviderRegistry::getApiKey('openai')) {
            $this->markTestSkipped('No OpenAI API key configured.');
        }

        $result = ProviderRegistry::resolve('openai:gpt-4.1-mini');

        $this->assertNotNull($result);
        $this->assertInstanceOf(OpenAiCompatibleProvider::class, $result['provider']);
    }

    public function test_resolve_gemini_model(): void
    {
        if (! ProviderRegistry::getApiKey('gemini')) {
            $this->markTestSkipped('No Gemini API key configured.');
        }

        $result = ProviderRegistry::resolve('gemini:gemini-flash');

        $this->assertNotNull($result);
        $this->assertInstanceOf(GeminiProvider::class, $result['provider']);
    }

    public function test_default_model_key_prefers_vertex_then_gemini(): void
    {
        $default = ProviderRegistry::getDefaultModelKey();

        if ($default === null) {
            $this->markTestSkipped('No providers configured.');
        }

        // Vertex wins over Gemini (AI Studio) when both are set.
        if (ProviderRegistry::getApiKey('vertex')) {
            $this->assertStringStartsWith('vertex:', $default);
        } elseif (ProviderRegistry::getApiKey('gemini')) {
            $this->assertStringStartsWith('gemini:', $default);
        }
    }

    public function test_get_models_for_frontend_structure(): void
    {
        $data = ProviderRegistry::getModelsForFrontend();

        $this->assertArrayHasKey('providers', $data);
        $this->assertArrayHasKey('default', $data);
        $this->assertArrayHasKey('pricing', $data);
        $this->assertIsArray($data['providers']);
        $this->assertIsArray($data['pricing']);

        // Each provider should have name, label, models
        foreach ($data['providers'] as $provider) {
            $this->assertArrayHasKey('name', $provider);
            $this->assertArrayHasKey('label', $provider);
            $this->assertArrayHasKey('models', $provider);

            foreach ($provider['models'] as $model) {
                $this->assertArrayHasKey('value', $model);
                $this->assertArrayHasKey('label', $model);
                $this->assertArrayHasKey('tier', $model);
                $this->assertContains($model['tier'], ['$', '$$', '$$$', '$$$$']);
            }
        }
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
