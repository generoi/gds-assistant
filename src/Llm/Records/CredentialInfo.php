<?php

namespace GeneroWP\Assistant\Llm\Records;

use GeneroWP\Assistant\Llm\CredentialResolver;

/**
 * Result of {@see CredentialResolver::resolve()} —
 * an LLM provider's API key together with where it came from.
 *
 * `key` is null when no credential was found; `source` is a structured tag
 * the settings UI uses to explain *how* a key was discovered (e.g.
 * `connector:env:ANTHROPIC_API_KEY`, `legacy:env:GDS_ASSISTANT_OPENAI_KEY`,
 * `missing:connector`). `connector` is the upstream connector record when
 * the resolution went through `wp_get_connectors()`. `setting` is the
 * `wp_options` row name when the key came from an option — surfaced as a
 * "you have an API key stored here" hint in the admin UI.
 */
final class CredentialInfo
{
    /**
     * @param  array<string, mixed>|null  $connector  The upstream connector record (if any).
     */
    public function __construct(
        public readonly ?string $key,
        public readonly string $source,
        public readonly ?array $connector,
        public readonly ?string $setting,
    ) {}

    public function hasKey(): bool
    {
        return $this->key !== null && $this->key !== '';
    }

    /**
     * @return array{key: string|null, source: string, connector: array<string, mixed>|null, setting: string|null}
     */
    public function toArray(): array
    {
        return [
            'key' => $this->key,
            'source' => $this->source,
            'connector' => $this->connector,
            'setting' => $this->setting,
        ];
    }
}
