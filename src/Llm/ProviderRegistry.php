<?php

namespace GeneroWP\Assistant\Llm;

/**
 * WordPress 7-only model registry.
 *
 * Provider credentials and routing belong to WordPress Core's AI Client and
 * Connectors APIs. This registry only exposes assistant model choices and
 * backwards-compatible aliases for previously stored skill preferences.
 */
class ProviderRegistry
{
    /** @var array<string, array{id: string, label: string, pricing: array, tier: string}> */
    private const MODEL_PREFERENCES = [
        'wordpress:auto' => [
            'id' => 'auto',
            'label' => 'Auto (WordPress AI Client)',
            'pricing' => [0, 0],
            'tier' => 'full',
        ],
        'wordpress:fast' => [
            'id' => 'fast',
            'label' => 'Fast available model',
            'pricing' => [0, 0],
            'tier' => 'read',
        ],
        'wordpress:balanced' => [
            'id' => 'balanced',
            'label' => 'Balanced available model',
            'pricing' => [0, 0],
            'tier' => 'standard',
        ],
        'wordpress:capable' => [
            'id' => 'capable',
            'label' => 'Most capable available model',
            'pricing' => [0, 0],
            'tier' => 'full',
        ],
    ];

    /** @var array<string, string> */
    private const LEGACY_MODEL_ALIASES = [
        'anthropic:haiku' => 'wordpress:fast',
        'anthropic:sonnet' => 'wordpress:capable',
        'anthropic:opus' => 'wordpress:capable',
        'anthropic:haiku-advisor' => 'wordpress:capable',
        'anthropic:advisor' => 'wordpress:capable',
        'anthropic:auto' => 'wordpress:auto',
        'openai:gpt-nano' => 'wordpress:fast',
        'openai:gpt-mini' => 'wordpress:balanced',
        'openai:gpt' => 'wordpress:capable',
        'openai:o4-mini' => 'wordpress:balanced',
        'openai:auto' => 'wordpress:auto',
        'gemini:gemini-flash-lite' => 'wordpress:fast',
        'gemini:gemini-2-flash' => 'wordpress:fast',
        'gemini:gemini-flash' => 'wordpress:fast',
        'gemini:gemini-pro' => 'wordpress:capable',
        'gemini:gemini-3-flash-lite' => 'wordpress:fast',
        'gemini:gemini-3-pro' => 'wordpress:capable',
        'gemini:auto' => 'wordpress:auto',
        'vertex:gemini-flash-lite' => 'wordpress:fast',
        'vertex:gemini-flash' => 'wordpress:fast',
        'vertex:gemini-pro' => 'wordpress:capable',
        'vertex:gemini-3-flash-lite' => 'wordpress:fast',
        'vertex:gemini-3-pro' => 'wordpress:capable',
        'groq:llama-8b-instant' => 'wordpress:fast',
        'groq:llama-scout' => 'wordpress:fast',
        'groq:llama-maverick' => 'wordpress:balanced',
        'groq:llama-70b' => 'wordpress:balanced',
        'mistral:mistral-small' => 'wordpress:fast',
        'mistral:mistral-medium' => 'wordpress:balanced',
        'mistral:mistral-large' => 'wordpress:capable',
        'xai:grok-fast' => 'wordpress:fast',
        'xai:grok' => 'wordpress:balanced',
        'deepseek:deepseek-chat' => 'wordpress:fast',
        'deepseek:deepseek-reasoner' => 'wordpress:balanced',
    ];

    /** @var array<string, string[]> */
    private const MODEL_PREFERENCE_IDS = [
        'wordpress:fast' => [
            'gemini-2.5-flash-lite',
            'gpt-5.4-nano',
            'claude-haiku-4-5-20251001',
        ],
        'wordpress:balanced' => [
            'gpt-5.4-mini',
            'gemini-2.5-flash',
            'claude-haiku-4-5-20251001',
        ],
        'wordpress:capable' => [
            'claude-sonnet-4-6',
            'gemini-3.1-pro-preview',
            'gpt-5.4',
            'gemini-2.5-pro',
        ],
        'wordpress:auto' => [],
    ];

    public static function registerDefaults(): void {}

    public static function register(string $name, array $config): void {}

    public static function getApiKey(string $providerName): ?string
    {
        return self::getCredentialInfo($providerName)['key'];
    }

    /**
     * @return array{key: string|null, source: string, connector: array|null, setting: string|null}
     */
    public static function getCredentialInfo(string $providerName): array
    {
        return [
            'key' => $providerName === 'wordpress' && AiSupport::supportsCoreTextGeneration() ? 'wordpress-ai-client' : null,
            'source' => $providerName === 'wordpress' && AiSupport::supportsCoreTextGeneration() ? 'wordpress:ai-client' : 'missing:wordpress-ai-client',
            'connector' => null,
            'setting' => null,
        ];
    }

    public static function getAvailable(): array
    {
        if (! AiSupport::supportsCoreTextGeneration()) {
            return [];
        }

        return [
            'wordpress' => [
                'label' => 'WordPress AI Client',
                'core' => true,
                'models' => self::MODEL_PREFERENCES,
                'default' => 'auto',
            ],
        ];
    }

    public static function hasAnyProvider(): bool
    {
        return AiSupport::supportsCoreTextGeneration();
    }

    /**
     * @return array{provider: LlmProviderInterface, modelId: string, label: string, tier: string}|null
     */
    public static function resolve(string $modelKey, int $maxTokens = 4096): ?array
    {
        if (! self::hasAnyProvider()) {
            return null;
        }

        $modelKey = self::normalizeModelKey($modelKey);
        $model = self::MODEL_PREFERENCES[$modelKey] ?? self::MODEL_PREFERENCES['wordpress:auto'];

        return [
            'provider' => new CoreAiProvider(
                modelPreference: self::modelPreferenceFor($modelKey),
                maxTokens: $maxTokens,
            ),
            'modelId' => $model['id'],
            'label' => $model['label'],
            'tier' => $model['tier'],
        ];
    }

    public static function getDefaultModelKey(): ?string
    {
        return self::hasAnyProvider() ? 'wordpress:auto' : null;
    }

    /**
     * @return array{providers: array, default: string|null, pricing: array}
     */
    public static function getModelsForFrontend(): array
    {
        $models = [];
        $pricing = [];

        foreach (self::MODEL_PREFERENCES as $key => $def) {
            $models[] = [
                'value' => $key,
                'label' => $def['label'],
                'tier' => self::costTier($def['pricing']),
                'capabilityTier' => $def['tier'],
            ];
            $pricing[$key] = $def['pricing'];
        }

        return [
            'providers' => self::hasAnyProvider() ? [[
                'name' => 'wordpress',
                'label' => 'WordPress AI Client',
                'models' => $models,
            ]] : [],
            'default' => self::getDefaultModelKey(),
            'pricing' => apply_filters('gds-assistant/model_pricing', $pricing),
        ];
    }

    /**
     * @return string[]
     */
    public static function coreModelPreference(string $modelKey = 'wordpress:auto'): array
    {
        return self::modelPreferenceFor(self::normalizeModelKey($modelKey));
    }

    private static function normalizeModelKey(string $modelKey): string
    {
        if ($modelKey === '') {
            return 'wordpress:auto';
        }

        if (isset(self::MODEL_PREFERENCES[$modelKey])) {
            return $modelKey;
        }

        return self::LEGACY_MODEL_ALIASES[$modelKey] ?? 'wordpress:auto';
    }

    /**
     * @return string[]
     */
    private static function modelPreferenceFor(string $modelKey): array
    {
        return self::MODEL_PREFERENCE_IDS[$modelKey] ?? [];
    }

    private static function costTier(array $pricing): string
    {
        $outputPrice = $pricing[1] ?? 0;

        return match (true) {
            $outputPrice <= 1 => '$',
            $outputPrice <= 5 => '$$',
            $outputPrice <= 20 => '$$$',
            default => '$$$$',
        };
    }
}
