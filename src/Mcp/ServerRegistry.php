<?php

namespace GeneroWP\Assistant\Mcp;

use GeneroWP\Assistant\Plugin;

/**
 * Resolves MCP server configs from filter + env and instantiates matching
 * auth strategies on demand.
 *
 * Config sources (merged in order, later wins):
 *   1. `gds-assistant/mcp_servers` filter  — array<string, array>  (recommended)
 *   2. GDS_ASSISTANT_MCP_SERVERS env var   — JSON object of the same shape
 *
 * Example config entry:
 *   'asana' => [
 *       'url'   => 'https://mcp.asana.com/sse',
 *       'label' => 'Asana',
 *       'auth'  => ['type' => 'oauth', 'scopes' => ['default']],
 *   ],
 */
class ServerRegistry
{
    /** @var array<string, McpServerConfig>|null */
    private static ?array $cache = null;

    /** @return array<string, McpServerConfig> */
    public static function all(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }

        $raw = [];

        $envRaw = Plugin::env('GDS_ASSISTANT_MCP_SERVERS');
        if (is_string($envRaw) && $envRaw !== '') {
            $decoded = json_decode($envRaw, true);
            if (is_array($decoded)) {
                $raw = array_merge($raw, $decoded);
            }
        }

        $raw = apply_filters('gds-assistant/mcp_servers', $raw);

        $configs = [];
        foreach ((array) $raw as $name => $entry) {
            if (! is_array($entry) || empty($entry['url'])) {
                continue;
            }
            try {
                $configs[$name] = new McpServerConfig(
                    name: (string) $name,
                    url: (string) $entry['url'],
                    auth: is_array($entry['auth'] ?? null) ? $entry['auth'] : ['type' => 'none'],
                    label: isset($entry['label']) ? (string) $entry['label'] : null,
                    enabled: ($entry['enabled'] ?? true) !== false,
                );
            } catch (\InvalidArgumentException $e) {
                error_log("[gds-assistant] Invalid MCP server config: {$e->getMessage()}");
            }
        }

        return self::$cache = $configs;
    }

    public static function get(string $name): ?McpServerConfig
    {
        return self::all()[$name] ?? null;
    }

    /**
     * Build the auth strategy for a server. For OAuth, the $userId scopes
     * credential lookup: each admin connects their own upstream account, so
     * tool calls act on behalf of whoever is chatting. Bearer and none auth
     * ignore $userId (credentials come from site config).
     */
    public static function auth(McpServerConfig $config, ?int $userId = null): AuthStrategyInterface
    {
        $userId ??= get_current_user_id();

        return match ($config->authType()) {
            'bearer' => new BearerAuth($config->auth),
            'oauth' => new OAuthAuth($config, (int) $userId),
            default => new NoneAuth,
        };
    }

    /** Drop in-memory cache — used by tests. */
    public static function resetCache(): void
    {
        self::$cache = null;
    }
}
