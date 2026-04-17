<?php

namespace GeneroWP\Assistant\Mcp;

/**
 * Split storage for MCP auth state:
 *
 *   - Server metadata (wp_options, site-wide):
 *       auth_endpoint, token_endpoint, registration_endpoint,
 *       scopes_supported, client_id, client_secret
 *     These are a property of the remote server + the WP site's DCR
 *     registration; they're the same for every admin.
 *
 *   - User tokens (user_meta, per-user):
 *       access_token, refresh_token, expires_at, token_type, scope
 *     Each admin connects their own account (Asana, Figma, etc.), so
 *     tool calls act on behalf of whoever triggered the chat turn.
 *
 * Secrets (access_token, refresh_token, client_secret) are encrypted at
 * rest via Encrypt (AES-256-GCM keyed from wp_salt). Public fields
 * (endpoints, expires_at, etc.) stay plaintext so admins can inspect them
 * in the DB when debugging. Bearer and none auth strategies don't use
 * this store.
 */
class TokenStore
{
    private const META_OPTION_PREFIX = 'gds_assistant_mcp_meta_';

    private const USER_META_PREFIX = 'gds_assistant_mcp_token_';

    /** Encrypted fields on server meta records. */
    private const SERVER_META_SECRETS = ['client_secret'];

    /** Encrypted fields on user-token records. */
    private const USER_TOKEN_SECRETS = ['access_token', 'refresh_token'];

    /* ------------------------------ Server meta ------------------------------ */

    public static function getServerMeta(string $serverName): array
    {
        $data = get_option(self::META_OPTION_PREFIX.$serverName, []);
        if (! is_array($data)) {
            return [];
        }

        return Encrypt::decryptKeys($data, self::SERVER_META_SECRETS);
    }

    public static function mergeServerMeta(string $serverName, array $patch): array
    {
        $current = self::getServerMeta($serverName);
        $merged = array_merge($current, $patch);
        $toStore = Encrypt::encryptKeys($merged, self::SERVER_META_SECRETS);
        update_option(self::META_OPTION_PREFIX.$serverName, $toStore, false);

        return $merged;
    }

    public static function deleteServerMeta(string $serverName): void
    {
        delete_option(self::META_OPTION_PREFIX.$serverName);
    }

    /* ------------------------------ User tokens ------------------------------ */

    public static function getUserTokens(string $serverName, int $userId): array
    {
        if ($userId <= 0) {
            return [];
        }
        $data = get_user_meta($userId, self::USER_META_PREFIX.$serverName, true);
        if (! is_array($data)) {
            return [];
        }

        return Encrypt::decryptKeys($data, self::USER_TOKEN_SECRETS);
    }

    public static function mergeUserTokens(string $serverName, int $userId, array $patch): array
    {
        if ($userId <= 0) {
            return [];
        }
        $current = self::getUserTokens($serverName, $userId);
        $merged = array_merge($current, $patch);
        $toStore = Encrypt::encryptKeys($merged, self::USER_TOKEN_SECRETS);
        update_user_meta($userId, self::USER_META_PREFIX.$serverName, $toStore);

        return $merged;
    }

    public static function deleteUserTokens(string $serverName, int $userId): void
    {
        if ($userId <= 0) {
            return;
        }
        delete_user_meta($userId, self::USER_META_PREFIX.$serverName);
    }

    public static function userHasToken(string $serverName, int $userId): bool
    {
        $data = self::getUserTokens($serverName, $userId);

        return ! empty($data['access_token']);
    }
}
