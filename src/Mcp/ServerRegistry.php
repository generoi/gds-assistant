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
 *       'url'   => 'https://mcp.asana.com/v2/mcp',
 *       'label' => 'Asana',
 *       'auth'  => ['type' => 'oauth', 'client_id' => '...', 'client_secret' => '...'],
 *   ],
 */
class ServerRegistry
{
    public const OPTION = 'gds_assistant_mcp_servers';

    /** @var array<string, array{config: McpServerConfig, origin: string}>|null */
    private static ?array $cache = null;

    /** @return array<string, McpServerConfig> */
    public static function all(): array
    {
        return array_map(fn ($e) => $e['config'], self::entries());
    }

    /**
     * Return raw entries keyed by server name, including the origin.
     * origin: 'admin' (user-added via UI), 'env' (env var), 'code'
     * (filter), or 'builtin' (hardcoded, e.g. future placeholders).
     *
     * @return array<string, array{config: McpServerConfig, origin: string}>
     */
    public static function entries(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }

        $sources = []; // [name => [entry, origin]]

        // 1. Admin-added via UI (stored in option). Lowest precedence so
        // code-defined servers can override with the same name.
        $stored = get_option(self::OPTION, []);
        if (is_array($stored)) {
            foreach ($stored as $name => $entry) {
                if (is_array($entry)) {
                    $sources[$name] = [$entry, 'admin'];
                }
            }
        }

        // 2. Env var (JSON) — overrides admin-added entries with the same name.
        $envRaw = Plugin::env('GDS_ASSISTANT_MCP_SERVERS');
        if (is_string($envRaw) && $envRaw !== '') {
            $decoded = json_decode($envRaw, true);
            if (is_array($decoded)) {
                foreach ($decoded as $name => $entry) {
                    if (is_array($entry)) {
                        $sources[$name] = [$entry, 'env'];
                    }
                }
            }
        }

        // 3. Filter — highest precedence (code always wins).
        $filtered = apply_filters('gds-assistant/mcp_servers', []);
        if (is_array($filtered)) {
            foreach ($filtered as $name => $entry) {
                if (is_array($entry)) {
                    $sources[$name] = [$entry, 'code'];
                }
            }
        }

        $configs = [];
        foreach ($sources as $name => [$entry, $origin]) {
            if (empty($entry['url'])) {
                continue;
            }
            try {
                $auth = is_array($entry['auth'] ?? null) ? $entry['auth'] : ['type' => 'none'];
                // Admin-origin entries encrypt client_secret at rest. Decrypt
                // it here so downstream code (OAuthAuth) sees plaintext.
                if ($origin === 'admin' && ! empty($auth['client_secret']) && is_string($auth['client_secret'])) {
                    $plain = Encrypt::decrypt($auth['client_secret']);
                    if ($plain !== null) {
                        $auth['client_secret'] = $plain;
                    }
                }
                $config = new McpServerConfig(
                    name: (string) $name,
                    url: (string) $entry['url'],
                    auth: $auth,
                    label: isset($entry['label']) ? (string) $entry['label'] : null,
                    enabled: ($entry['enabled'] ?? true) !== false,
                );
                $configs[$name] = ['config' => $config, 'origin' => $origin];
            } catch (\InvalidArgumentException $e) {
                error_log("[gds-assistant] Invalid MCP server config: {$e->getMessage()}");
            }
        }

        return self::$cache = $configs;
    }

    /** Return the origin of a server: admin | env | code. Null if unknown. */
    public static function origin(string $name): ?string
    {
        return self::entries()[$name]['origin'] ?? null;
    }

    /**
     * Add or update an admin-configured server. Returns WP_Error if the
     * name collides with a code/env entry (those are read-only) or if
     * the config fails validation.
     *
     * @param  array{url: string, label?: string, auth?: array, enabled?: bool}  $entry
     */
    public static function upsertAdminServer(string $name, array $entry): McpServerConfig|\WP_Error
    {
        $name = sanitize_key($name);
        if ($name === '' || ! preg_match('/^[a-z][a-z0-9_]*$/', $name)) {
            return new \WP_Error('invalid_name', 'Server name must be lowercase alphanumeric with underscores.');
        }

        // Block overwriting code/env entries — those own the name.
        $existingOrigin = self::origin($name);
        if ($existingOrigin !== null && $existingOrigin !== 'admin') {
            return new \WP_Error(
                'name_locked',
                "A {$existingOrigin}-defined server already uses the name '{$name}'. Pick a different name."
            );
        }

        // Round-trip through McpServerConfig to validate URL/auth shape.
        try {
            $config = new McpServerConfig(
                name: $name,
                url: (string) ($entry['url'] ?? ''),
                auth: is_array($entry['auth'] ?? null) ? $entry['auth'] : ['type' => 'none'],
                label: isset($entry['label']) ? (string) $entry['label'] : null,
                enabled: ($entry['enabled'] ?? true) !== false,
            );
        } catch (\InvalidArgumentException $e) {
            return new \WP_Error('invalid_config', $e->getMessage());
        }

        $stored = get_option(self::OPTION, []);
        if (! is_array($stored)) {
            $stored = [];
        }

        $authToStore = $config->auth;

        // If the caller didn't supply a client_secret but we already have one
        // stored (typical on edit — UI sends "" to mean "keep existing"),
        // preserve the encrypted value rather than dropping it.
        $previousAuth = is_array($stored[$name]['auth'] ?? null) ? $stored[$name]['auth'] : [];
        $incomingSecret = $authToStore['client_secret'] ?? null;
        if (($incomingSecret === null || $incomingSecret === '') && ! empty($previousAuth['client_secret'])) {
            $authToStore['client_secret'] = $previousAuth['client_secret'];
        } elseif (is_string($incomingSecret) && $incomingSecret !== '') {
            // Fresh secret from the form — encrypt before persisting.
            $authToStore['client_secret'] = Encrypt::encrypt($incomingSecret);
        } else {
            unset($authToStore['client_secret']);
        }

        $stored[$name] = [
            'url' => $config->url,
            'label' => $config->label,
            'auth' => $authToStore,
            'enabled' => $config->enabled,
        ];
        update_option(self::OPTION, $stored, false);
        self::resetCache();

        return $config;
    }

    public static function deleteAdminServer(string $name): bool|\WP_Error
    {
        $origin = self::origin($name);
        if ($origin === null) {
            return new \WP_Error('not_found', 'MCP server not found.');
        }
        if ($origin !== 'admin') {
            return new \WP_Error('read_only', "Server '{$name}' is configured in code/env and can't be deleted from the UI.");
        }

        $stored = get_option(self::OPTION, []);
        if (is_array($stored) && isset($stored[$name])) {
            unset($stored[$name]);
            update_option(self::OPTION, $stored, false);
        }

        // Purge any tokens and server metadata associated with this server.
        TokenStore::deleteServerMeta($name);
        self::resetCache();

        return true;
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
