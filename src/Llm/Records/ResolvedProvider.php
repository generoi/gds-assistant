<?php

namespace GeneroWP\Assistant\Llm\Records;

use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Llm\CoreAiProvider;
use GeneroWP\Assistant\Llm\LlmProviderInterface;
use GeneroWP\Assistant\Llm\MessageLoop;
use GeneroWP\Assistant\Llm\ProviderRegistry;

/**
 * Result of {@see ProviderRegistry::resolve()} — a
 * fully-instantiated LLM provider together with the model id, friendly
 * label, and capability tier the caller asked for. Returned by the registry
 * after credential discovery + model lookup; consumers pass the provider on
 * to {@see MessageLoop} or
 * {@see CoreAiProvider}, and surface the label + tier
 * in token-usage emits.
 *
 * Capability tiers (`read`, `standard`, `full`) determine which tools the
 * model is allowed to see — see {@see ToolRestrictor}.
 * `tier` is the cached capability tier from the model config, NOT a runtime
 * permission check.
 */
final class ResolvedProvider
{
    public function __construct(
        public readonly LlmProviderInterface $provider,
        public readonly string $modelId,
        public readonly string $label,
        public readonly string $tier,
    ) {}
}
