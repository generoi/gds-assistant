<?php

namespace GeneroWP\Assistant\Mcp;

/**
 * Declarative config for a remote MCP server.
 *
 * `auth` is one of:
 *   ['type' => 'none']
 *   ['type' => 'bearer', 'token' => '...']                 (static token)
 *   ['type' => 'bearer', 'env' => 'MY_TOKEN_ENV']          (env-backed token)
 *   ['type' => 'oauth',  'scopes' => ['read', 'write'],    (OAuth 2.1 + PKCE)
 *                        'client_id' => '...',              (optional — DCR if absent)
 *                        'client_secret' => '...']          (optional)
 */
final class McpServerConfig
{
    public function __construct(
        public readonly string $name,
        public readonly string $url,
        public readonly array $auth = ['type' => 'none'],
        public readonly ?string $label = null,
        public readonly bool $enabled = true,
    ) {
        if (! preg_match('/^[a-z0-9_]+$/', $name)) {
            throw new \InvalidArgumentException(
                "MCP server name must be lowercase alphanumeric + underscores: {$name}",
            );
        }
    }

    public function displayLabel(): string
    {
        return $this->label ?? ucfirst(str_replace('_', ' ', $this->name));
    }

    public function authType(): string
    {
        return $this->auth['type'] ?? 'none';
    }
}
