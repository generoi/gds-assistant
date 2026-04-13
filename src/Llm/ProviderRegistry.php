<?php

namespace GeneroWP\Assistant\Llm;

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

        // Anthropic (Claude)
        self::register('anthropic', [
            'label' => 'Anthropic',
            'env' => ['GDS_ASSISTANT_ANTHROPIC_KEY', 'GDS_ASSISTANT_API_KEY', 'ANTHROPIC_API_KEY'],
            'models' => [
                'haiku' => ['id' => 'claude-haiku-4-5-20251001', 'label' => 'Haiku', 'pricing' => [0.8, 4]],
                'sonnet' => ['id' => 'claude-sonnet-4-6', 'label' => 'Sonnet', 'pricing' => [3, 15]],
                'opus' => ['id' => 'claude-opus-4-6', 'label' => 'Opus', 'pricing' => [15, 75]],
                'haiku-advisor' => ['id' => 'claude-haiku-4-5-20251001', 'label' => 'Haiku+Advisor', 'advisor' => true, 'pricing' => [0.8, 4]],
                'advisor' => ['id' => 'claude-sonnet-4-6', 'label' => 'Sonnet+Advisor', 'advisor' => true, 'pricing' => [3, 15]],
            ],
            'default' => 'sonnet',
        ]);

        // OpenAI
        self::register('openai', [
            'label' => 'OpenAI',
            'env' => ['GDS_ASSISTANT_OPENAI_KEY', 'OPENAI_API_KEY'],
            'models' => [
                'gpt-4.1-mini' => ['id' => 'gpt-4.1-mini', 'label' => 'GPT-4.1 Mini', 'pricing' => [0.4, 1.6]],
                'gpt-4.1' => ['id' => 'gpt-4.1', 'label' => 'GPT-4.1', 'pricing' => [2, 8]],
                'o4-mini' => ['id' => 'o4-mini', 'label' => 'o4 Mini', 'pricing' => [1.1, 4.4]],
            ],
            'default' => 'gpt-4.1-mini',
            'base_url' => 'https://api.openai.com/v1',
        ]);

        // Google Gemini
        self::register('gemini', [
            'label' => 'Gemini',
            'env' => ['GDS_ASSISTANT_GEMINI_KEY', 'GOOGLE_AI_API_KEY'],
            'models' => [
                'gemini-flash' => ['id' => 'gemini-2.5-flash-preview-05-20', 'label' => 'Flash 2.5', 'pricing' => [0.15, 0.6]],
                'gemini-pro' => ['id' => 'gemini-2.5-pro-preview-06-05', 'label' => 'Pro 2.5', 'pricing' => [1.25, 10]],
            ],
            'default' => 'gemini-flash',
        ]);

        // Mistral
        self::register('mistral', [
            'label' => 'Mistral',
            'env' => ['GDS_ASSISTANT_MISTRAL_KEY', 'MISTRAL_API_KEY'],
            'models' => [
                'mistral-large' => ['id' => 'mistral-large-latest', 'label' => 'Large', 'pricing' => [2, 6]],
            ],
            'default' => 'mistral-large',
            'base_url' => 'https://api.mistral.ai/v1',
        ]);

        // Groq
        self::register('groq', [
            'label' => 'Groq',
            'env' => ['GDS_ASSISTANT_GROQ_KEY', 'GROQ_API_KEY'],
            'models' => [
                'llama-scout' => ['id' => 'meta-llama/llama-4-scout-17b-16e-instruct', 'label' => 'Llama Scout', 'pricing' => [0.11, 0.34]],
                'llama-maverick' => ['id' => 'meta-llama/llama-4-maverick-17b-128e-instruct', 'label' => 'Llama Maverick', 'pricing' => [0.5, 0.77]],
            ],
            'default' => 'llama-scout',
            'base_url' => 'https://api.groq.com/openai/v1',
        ]);

        // xAI (Grok)
        self::register('xai', [
            'label' => 'xAI',
            'env' => ['GDS_ASSISTANT_XAI_KEY', 'XAI_API_KEY'],
            'models' => [
                'grok-3' => ['id' => 'grok-3', 'label' => 'Grok 3', 'pricing' => [3, 15]],
                'grok-3-fast' => ['id' => 'grok-3-fast', 'label' => 'Grok 3 Fast', 'pricing' => [5, 25]],
            ],
            'default' => 'grok-3-fast',
            'base_url' => 'https://api.x.ai/v1',
        ]);

        // DeepSeek
        self::register('deepseek', [
            'label' => 'DeepSeek',
            'env' => ['GDS_ASSISTANT_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY'],
            'models' => [
                'deepseek-chat' => ['id' => 'deepseek-chat', 'label' => 'DeepSeek Chat', 'pricing' => [0.27, 1.1]],
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
            $key = function_exists('env') ? env($envVar) : (getenv($envVar) ?: null);
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
        ];
    }

    /**
     * Get the default model key (first available provider's default).
     */
    public static function getDefaultModelKey(): ?string
    {
        $defaultProvider = env('GDS_ASSISTANT_DEFAULT_PROVIDER') ?: null;

        foreach (self::getAvailable() as $name => $config) {
            if ($defaultProvider && $name !== $defaultProvider) {
                continue;
            }

            return $name.':'.$config['default'];
        }

        // If preferred provider not found, fall back to first available
        if ($defaultProvider) {
            foreach (self::getAvailable() as $name => $config) {
                return $name.':'.$config['default'];
            }
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
                $models[] = [
                    'value' => $name.':'.$key,
                    'label' => $def['label'],
                ];
            }
            $providers[] = [
                'name' => $name,
                'label' => $config['label'],
                'models' => $models,
            ];
        }

        // Pricing map for frontend cost tracking ($/M tokens: [input, output])
        $pricing = [];
        foreach (self::getAvailable() as $name => $config) {
            foreach ($config['models'] as $key => $def) {
                if (isset($def['pricing'])) {
                    $pricing[$name.':'.$key] = $def['pricing'];
                }
            }
        }

        return [
            'providers' => $providers,
            'default' => self::getDefaultModelKey(),
            'pricing' => $pricing,
        ];
    }
}
