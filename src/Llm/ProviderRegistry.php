<?php

namespace GeneroWP\Assistant\Llm;

use GeneroWP\Assistant\Plugin;

/**
 * Discovers available LLM providers based on configured API keys.
 * Each provider defines its env var, models, and factory method.
 */
class ProviderRegistry
{
    /** @var array<string, array{env: string|string[], models: array, factory: callable}> */
    private static array $providers = [];

    private static bool $registered = false;

    /**
     * Register all built-in providers.
     */
    public static function registerDefaults(): void
    {
        if (self::$registered) {
            return;
        }
        self::$registered = true;

        // Pricing last verified against primary sources on 2026-04-16.
        // Run `php bin/list-models.php` to check for new model IDs per provider.
        // Pricing pages: see the comment above each provider block.

        // Anthropic (Claude) — https://platform.claude.com/docs/en/about-claude/pricing
        self::register('anthropic', [
            'label' => 'Anthropic',
            'env' => ['GDS_ASSISTANT_ANTHROPIC_KEY', 'GDS_ASSISTANT_API_KEY', 'ANTHROPIC_API_KEY'],
            'models' => [
                'haiku' => ['id' => 'claude-haiku-4-5-20251001', 'label' => 'Haiku 4.5', 'pricing' => [1, 5], 'tier' => 'standard'],
                'sonnet' => ['id' => 'claude-sonnet-4-6', 'label' => 'Sonnet 4.6', 'pricing' => [3, 15], 'tier' => 'full'],
                'opus' => ['id' => 'claude-opus-4-7', 'label' => 'Opus 4.7', 'pricing' => [5, 25], 'tier' => 'full'],
                'haiku-advisor' => ['id' => 'claude-haiku-4-5-20251001', 'label' => 'Haiku+Advisor', 'advisor' => true, 'pricing' => [1, 5], 'tier' => 'full'],
                'advisor' => ['id' => 'claude-sonnet-4-6', 'label' => 'Sonnet+Advisor', 'advisor' => true, 'pricing' => [3, 15], 'tier' => 'full'],
            ],
            'default' => 'sonnet',
        ]);

        // OpenAI — https://openai.com/api/pricing/
        self::register('openai', [
            'label' => 'OpenAI',
            'env' => ['GDS_ASSISTANT_OPENAI_KEY', 'OPENAI_API_KEY'],
            'models' => [
                'gpt-nano' => ['id' => 'gpt-5.4-nano', 'label' => 'GPT-5.4 Nano', 'pricing' => [0.20, 1.25], 'tier' => 'read'],
                'gpt-mini' => ['id' => 'gpt-5.4-mini', 'label' => 'GPT-5.4 Mini', 'pricing' => [0.75, 4.50], 'tier' => 'standard'],
                'gpt' => ['id' => 'gpt-5.4', 'label' => 'GPT-5.4', 'pricing' => [2.50, 15], 'tier' => 'full'],
                'o4-mini' => ['id' => 'o4-mini', 'label' => 'o4 Mini (reasoning)', 'pricing' => [1.1, 4.4], 'tier' => 'standard'],
                // gpt-5.4-pro omitted: only available via /v1/completions (not chat/completions), incompatible with OpenAiCompatibleProvider.
            ],
            'default' => 'gpt-mini',
            'base_url' => 'https://api.openai.com/v1',
        ]);

        // Google Gemini (AI Studio) — https://ai.google.dev/gemini-api/docs/pricing
        // Note: free tier uses prompts for training — prefer Vertex for production/customer data.
        self::register('gemini', [
            'label' => 'Gemini',
            'env' => ['GDS_ASSISTANT_GEMINI_KEY', 'GOOGLE_AI_API_KEY'],
            'models' => [
                'gemini-flash-lite' => ['id' => 'gemini-2.5-flash-lite', 'label' => 'Flash-Lite 2.5', 'pricing' => [0.10, 0.40], 'tier' => 'read'],
                // gemini-2.0-flash-lite omitted: "no longer available to new users" per AI Studio as of 2026-04-16.
                'gemini-2-flash' => ['id' => 'gemini-2.0-flash', 'label' => 'Flash 2.0', 'pricing' => [0.10, 0.40], 'tier' => 'read'],
                'gemini-flash' => ['id' => 'gemini-2.5-flash', 'label' => 'Flash 2.5', 'pricing' => [0.30, 2.50], 'tier' => 'read'],
                'gemini-pro' => ['id' => 'gemini-2.5-pro', 'label' => 'Pro 2.5', 'pricing' => [1.25, 10], 'tier' => 'full'],
                'gemini-3-flash-lite' => ['id' => 'gemini-3.1-flash-lite-preview', 'label' => 'Flash-Lite 3.1 (preview)', 'pricing' => [0.25, 1.50], 'tier' => 'read'],
                'gemini-3-pro' => ['id' => 'gemini-3.1-pro-preview', 'label' => 'Pro 3.1 (preview)', 'pricing' => [2, 12], 'tier' => 'full'],
            ],
            'default' => 'gemini-flash-lite',
        ]);

        // Vertex AI Express Mode — https://cloud.google.com/vertex-ai/generative-ai/pricing
        // Express Mode API keys start with "AQ." and are obtained from console.cloud.google.com (Vertex AI Studio → API keys).
        // Note: gemini-2.0-flash is NOT reachable on Vertex Express (returns 404) — omitted here but present in the AI Studio provider above.
        self::register('vertex', [
            'label' => 'Vertex AI',
            'env' => ['GDS_ASSISTANT_VERTEX_KEY', 'VERTEX_API_KEY'],
            'models' => [
                'gemini-flash-lite' => ['id' => 'gemini-2.5-flash-lite', 'label' => 'Flash-Lite 2.5 (Vertex)', 'pricing' => [0.10, 0.40], 'tier' => 'read'],
                'gemini-flash' => ['id' => 'gemini-2.5-flash', 'label' => 'Flash 2.5 (Vertex)', 'pricing' => [0.30, 2.50], 'tier' => 'read'],
                'gemini-pro' => ['id' => 'gemini-2.5-pro', 'label' => 'Pro 2.5 (Vertex)', 'pricing' => [1.25, 10], 'tier' => 'full'],
                'gemini-3-flash-lite' => ['id' => 'gemini-3.1-flash-lite-preview', 'label' => 'Flash-Lite 3.1 (Vertex, preview)', 'pricing' => [0.25, 1.50], 'tier' => 'read'],
                'gemini-3-pro' => ['id' => 'gemini-3.1-pro-preview', 'label' => 'Pro 3.1 (Vertex, preview)', 'pricing' => [2, 12], 'tier' => 'full'],
            ],
            'default' => 'gemini-flash-lite',
        ]);

        // Mistral — https://mistral.ai/pricing
        // TODO: pricing below was taken from secondary sources; docs page was JS-obfuscated at verification time.
        self::register('mistral', [
            'label' => 'Mistral',
            'env' => ['GDS_ASSISTANT_MISTRAL_KEY', 'MISTRAL_API_KEY'],
            'models' => [
                'mistral-small' => ['id' => 'mistral-small-latest', 'label' => 'Small 3.1', 'pricing' => [0.10, 0.30], 'tier' => 'read'],
                'mistral-medium' => ['id' => 'mistral-medium-latest', 'label' => 'Medium 3', 'pricing' => [0.40, 2], 'tier' => 'standard'],
                'mistral-large' => ['id' => 'mistral-large-latest', 'label' => 'Large 3', 'pricing' => [0.50, 1.50], 'tier' => 'full'],
            ],
            'default' => 'mistral-medium',
            'base_url' => 'https://api.mistral.ai/v1',
        ]);

        // Groq — https://groq.com/pricing/
        self::register('groq', [
            'label' => 'Groq',
            'env' => ['GDS_ASSISTANT_GROQ_KEY', 'GROQ_API_KEY'],
            'models' => [
                'llama-8b-instant' => ['id' => 'llama-3.1-8b-instant', 'label' => 'Llama 3.1 8B Instant', 'pricing' => [0.05, 0.08], 'tier' => 'read'],
                'llama-scout' => ['id' => 'meta-llama/llama-4-scout-17b-16e-instruct', 'label' => 'Llama 4 Scout', 'pricing' => [0.11, 0.34], 'tier' => 'read'],
                'llama-maverick' => ['id' => 'meta-llama/llama-4-maverick-17b-128e-instruct', 'label' => 'Llama 4 Maverick', 'pricing' => [0.50, 0.77], 'tier' => 'read'],
                'llama-70b' => ['id' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B Versatile', 'pricing' => [0.59, 0.79], 'tier' => 'standard'],
            ],
            'default' => 'llama-scout',
            'base_url' => 'https://api.groq.com/openai/v1',
        ]);

        // xAI (Grok) — https://docs.x.ai/developers/models
        self::register('xai', [
            'label' => 'xAI',
            'env' => ['GDS_ASSISTANT_XAI_KEY', 'XAI_API_KEY'],
            'models' => [
                'grok-fast' => ['id' => 'grok-4-fast-non-reasoning', 'label' => 'Grok 4 Fast', 'pricing' => [0.20, 0.50], 'tier' => 'read'],
                'grok' => ['id' => 'grok-4', 'label' => 'Grok 4', 'pricing' => [2, 6], 'tier' => 'standard'],
            ],
            'default' => 'grok-fast',
            'base_url' => 'https://api.x.ai/v1',
        ]);

        // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing/
        self::register('deepseek', [
            'label' => 'DeepSeek',
            'env' => ['GDS_ASSISTANT_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY'],
            'models' => [
                'deepseek-chat' => ['id' => 'deepseek-chat', 'label' => 'DeepSeek Chat (V3.2)', 'pricing' => [0.28, 0.42], 'tier' => 'read'],
                'deepseek-reasoner' => ['id' => 'deepseek-reasoner', 'label' => 'DeepSeek Reasoner (R1)', 'pricing' => [0.28, 0.42], 'tier' => 'standard'],
            ],
            'default' => 'deepseek-chat',
            'base_url' => 'https://api.deepseek.com/v1',
        ]);

        do_action('gds-assistant/register_providers');
    }

    public static function register(string $name, array $config): void
    {
        self::$providers[$name] = $config;
    }

    /**
     * Get API key for a provider, checking multiple env var names.
     */
    public static function getApiKey(string $providerName): ?string
    {
        $config = self::$providers[$providerName] ?? null;
        if (! $config) {
            return null;
        }

        $envVars = (array) ($config['env'] ?? []);
        foreach ($envVars as $envVar) {
            $key = Plugin::env($envVar);
            if ($key) {
                return $key;
            }
        }

        return null;
    }

    /**
     * Get all available providers (those with API keys configured).
     *
     * @return array<string, array{label: string, models: array, default: string}>
     */
    public static function getAvailable(): array
    {
        self::registerDefaults();

        $available = [];
        foreach (self::$providers as $name => $config) {
            if (self::getApiKey($name)) {
                $available[$name] = $config;
            }
        }

        return $available;
    }

    /**
     * Check if any provider is configured.
     */
    public static function hasAnyProvider(): bool
    {
        return ! empty(self::getAvailable());
    }

    /**
     * Resolve a model key (e.g. "anthropic:sonnet") to a provider instance.
     *
     * @return array{provider: LlmProviderInterface, modelId: string, label: string}|null
     */
    public static function resolve(string $modelKey, int $maxTokens = 4096): ?array
    {
        self::registerDefaults();

        // Parse "provider:model" format or just "model" (searches all providers)
        if (str_contains($modelKey, ':')) {
            [$providerName, $modelName] = explode(':', $modelKey, 2);
        } else {
            // Search all available providers for this model key
            $providerName = null;
            $modelName = $modelKey;
            foreach (self::getAvailable() as $name => $config) {
                if (isset($config['models'][$modelKey])) {
                    $providerName = $name;
                    break;
                }
            }
        }

        if (! $providerName) {
            return null;
        }

        $config = self::$providers[$providerName] ?? null;
        $apiKey = self::getApiKey($providerName);
        if (! $config || ! $apiKey) {
            return null;
        }

        $modelDef = $config['models'][$modelName] ?? null;
        if (! $modelDef) {
            // Try the default model for this provider
            $modelName = $config['default'] ?? '';
            $modelDef = $config['models'][$modelName] ?? null;
        }

        if (! $modelDef) {
            return null;
        }

        $modelId = $modelDef['id'];
        $useAdvisor = ! empty($modelDef['advisor']);

        $provider = match ($providerName) {
            'anthropic' => new AnthropicProvider(
                apiKey: $apiKey,
                model: $modelId,
                maxTokens: $maxTokens,
                useAdvisor: $useAdvisor,
            ),
            'gemini' => new GeminiProvider(
                apiKey: $apiKey,
                model: $modelId,
                maxTokens: $maxTokens,
            ),
            'vertex' => new VertexExpressProvider(
                apiKey: $apiKey,
                model: $modelId,
                maxTokens: $maxTokens,
            ),
            default => new OpenAiCompatibleProvider(
                apiKey: $apiKey,
                model: $modelId,
                maxTokens: $maxTokens,
                baseUrl: $config['base_url'] ?? 'https://api.openai.com/v1',
                providerName: $providerName,
            ),
        };

        return [
            'provider' => $provider,
            'modelId' => $modelId,
            'label' => $modelDef['label'],
            'tier' => $modelDef['tier'] ?? 'standard',
        ];
    }

    /**
     * Get the default model key (first available provider's default).
     */
    /** Preferred provider order when no explicit default is set. */
    private const PROVIDER_PRIORITY = ['vertex', 'gemini', 'anthropic', 'groq', 'openai', 'deepseek', 'mistral', 'xai'];

    public static function getDefaultModelKey(): ?string
    {
        $defaultProvider = Plugin::env('GDS_ASSISTANT_DEFAULT_PROVIDER') ?: null;
        $available = self::getAvailable();

        // Explicit default
        if ($defaultProvider && isset($available[$defaultProvider])) {
            return $defaultProvider.':'.$available[$defaultProvider]['default'];
        }

        // Priority order: cheapest fast model first
        foreach (self::PROVIDER_PRIORITY as $name) {
            if (isset($available[$name])) {
                return $name.':'.$available[$name]['default'];
            }
        }

        // Fallback to first available
        foreach ($available as $name => $config) {
            return $name.':'.$config['default'];
        }

        return null;
    }

    /**
     * Get available models grouped by provider for the JS frontend.
     *
     * @return array{providers: array, default: string|null}
     */
    public static function getModelsForFrontend(): array
    {
        $providers = [];
        foreach (self::getAvailable() as $name => $config) {
            $models = [];
            foreach ($config['models'] as $key => $def) {
                $pricing = $def['pricing'] ?? [0, 0];
                // Cost tier based on output price (dominant cost factor)
                $outputPrice = $pricing[1];
                $tier = match (true) {
                    $outputPrice <= 1 => '$',
                    $outputPrice <= 5 => '$$',
                    $outputPrice <= 20 => '$$$',
                    default => '$$$$',
                };

                $capTier = $def['tier'] ?? 'standard';
                $models[] = [
                    'value' => $name.':'.$key,
                    'label' => $def['label'],
                    'tier' => $tier,
                    'capabilityTier' => $capTier,
                ];
            }
            $providers[] = [
                'name' => $name,
                'label' => $config['label'],
                'models' => $models,
            ];
        }

        // Pricing map for frontend cost tracking ($/M tokens: [input, output])
        // Last verified: 2026-04-13. Override via gds-assistant/model_pricing filter.
        $pricing = [];
        foreach (self::getAvailable() as $name => $config) {
            foreach ($config['models'] as $key => $def) {
                if (isset($def['pricing'])) {
                    $pricing[$name.':'.$key] = $def['pricing'];
                }
            }
        }

        $pricing = apply_filters('gds-assistant/model_pricing', $pricing);

        return [
            'providers' => $providers,
            'default' => self::getDefaultModelKey(),
            'pricing' => $pricing,
        ];
    }
}
