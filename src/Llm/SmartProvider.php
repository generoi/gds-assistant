<?php

namespace GeneroWP\Assistant\Llm;

/**
 * Smart model routing: cheap model for tool-routing turns, full model for
 * user-facing responses. Stays within one provider family to preserve cache.
 *
 * Turn detection heuristic: if the last user message contains tool_result
 * blocks, the LLM is processing tool output (deciding next tool or
 * summarising results) → cheap model. Otherwise → full model.
 *
 * Includes cross-provider fallback: if the primary provider fails (rate
 * limit, outage), retries with the best available alternative.
 */
class SmartProvider implements LlmProviderInterface
{
    public function __construct(
        private readonly LlmProviderInterface $cheapProvider,
        private readonly LlmProviderInterface $fullProvider,
        private readonly string $providerName,
    ) {}

    public function name(): string
    {
        return $this->providerName;
    }

    public function stream(
        array $messages,
        array $tools,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        $provider = $this->selectProvider($messages);

        try {
            return $provider->stream($messages, $tools, $onEvent, $systemPrompt);
        } catch (\Throwable $e) {
            // Primary provider failed — try cross-provider fallback.
            $fallback = $this->resolveFallback();
            if ($fallback) {
                error_log("[gds-assistant] SmartProvider: {$this->providerName} failed ({$e->getMessage()}), falling back to {$fallback->name()}");
                $onEvent('text_delta', [
                    'text' => "\n_Provider unavailable, switched to fallback._\n",
                ]);

                return $fallback->stream($messages, $tools, $onEvent, $systemPrompt);
            }

            throw $e;
        }
    }

    private function selectProvider(array $messages): LlmProviderInterface
    {
        return self::isToolRoutingTurn($messages)
            ? $this->cheapProvider
            : $this->fullProvider;
    }

    /**
     * Detect whether the upcoming LLM call is a tool-routing turn (cheap)
     * vs. a user-facing response turn (full).
     *
     * Heuristic: if the last user message contains tool_result blocks, the
     * LLM is processing tool output. It will either call more tools or write
     * a summary — both are fine on a cheaper model.
     */
    public static function isToolRoutingTurn(array $messages): bool
    {
        if (empty($messages)) {
            return false;
        }

        $last = end($messages);
        if (($last['role'] ?? '') !== 'user' || ! is_array($last['content'] ?? null)) {
            return false;
        }

        foreach ($last['content'] as $block) {
            if (($block['type'] ?? '') === 'tool_result') {
                return true;
            }
        }

        return false;
    }

    /**
     * Find the best available fallback provider (different from the primary).
     */
    private function resolveFallback(): ?LlmProviderInterface
    {
        // Try to resolve a 'full' tier model from a different provider.
        $available = ProviderRegistry::getAvailable();

        // Priority: providers that typically have good tool-use support.
        $fallbackOrder = ['anthropic', 'openai', 'gemini', 'vertex', 'groq', 'mistral', 'xai', 'deepseek'];

        foreach ($fallbackOrder as $name) {
            if ($name === $this->providerName || ! isset($available[$name])) {
                continue;
            }

            // Pick the default model from this provider.
            $modelKey = $name.':'.($available[$name]['default'] ?? '');
            $resolved = ProviderRegistry::resolve($modelKey);
            if ($resolved) {
                return $resolved['provider'];
            }
        }

        return null;
    }
}
