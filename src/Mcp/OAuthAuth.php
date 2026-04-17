<?php

namespace GeneroWP\Assistant\Mcp;

/**
 * OAuth 2.1 + PKCE auth strategy for MCP servers.
 *
 * Tokens are per-user — each admin connects their own upstream account so
 * tool calls act on behalf of whoever is chatting. Server metadata and any
 * RFC 7591 dynamic-client-registration result are shared across the site
 * (one registration per WP install).
 *
 * Implements:
 *   - RFC 9728 protected-resource metadata (preferred) and RFC 8414
 *     authorization-server metadata discovery
 *   - RFC 7591 dynamic client registration when the server advertises it
 *     and no static client_id is configured
 *   - Authorization-code flow with PKCE (S256)
 *   - Refresh-token rotation
 */
class OAuthAuth implements AuthStrategyInterface
{
    /** Seconds before expiry to proactively refresh. */
    private const REFRESH_MARGIN = 60;

    public function __construct(
        private readonly McpServerConfig $server,
        private readonly int $userId,
    ) {}

    public function headers(): array
    {
        $token = $this->getValidAccessToken();
        if (! $token) {
            return [];
        }

        return ['Authorization' => 'Bearer '.$token];
    }

    public function isAuthenticated(): bool
    {
        return (bool) $this->getValidAccessToken();
    }

    public function handleUnauthorized(): bool
    {
        // Server rejected our token — discard and try a refresh if we have one.
        $stored = TokenStore::getUserTokens($this->server->name, $this->userId);
        if (empty($stored['refresh_token'])) {
            return false;
        }
        TokenStore::mergeUserTokens($this->server->name, $this->userId, [
            'access_token' => null,
            'expires_at' => 0,
        ]);

        return (bool) $this->refreshAccessToken();
    }

    /** Return a valid access token, refreshing transparently if needed. */
    private function getValidAccessToken(): ?string
    {
        if ($this->userId <= 0) {
            return null;
        }
        $stored = TokenStore::getUserTokens($this->server->name, $this->userId);
        $accessToken = $stored['access_token'] ?? null;
        $expiresAt = (int) ($stored['expires_at'] ?? 0);

        if ($accessToken && ($expiresAt === 0 || $expiresAt - self::REFRESH_MARGIN > time())) {
            return $accessToken;
        }

        if (! empty($stored['refresh_token'])) {
            return $this->refreshAccessToken();
        }

        return null;
    }

    /* ----------------------------- Public flow ----------------------------- */

    /**
     * Kick off an authorization-code + PKCE flow. Returns the URL the user
     * should be redirected to. Callers are responsible for routing the user
     * there (e.g. wp_redirect() from an admin-post handler).
     */
    public function startAuthorization(string $redirectUri): string|\WP_Error
    {
        if ($this->userId <= 0) {
            return new \WP_Error('oauth_no_user', 'OAuth connect requires a logged-in user');
        }

        $meta = $this->getAuthorizationServerMetadata();
        if (is_wp_error($meta)) {
            return $meta;
        }

        $client = $this->ensureClient($meta, $redirectUri);
        if (is_wp_error($client)) {
            return $client;
        }

        $verifier = self::randomUrlSafe(64);
        $challenge = self::pkceChallenge($verifier);
        $state = self::randomUrlSafe(32);

        set_transient($this->pendingTransientKey($state), [
            'code_verifier' => $verifier,
            'redirect_uri' => $redirectUri,
            'user_id' => $this->userId,
            'created_at' => time(),
        ], 15 * MINUTE_IN_SECONDS);

        $scopes = $this->server->auth['scopes'] ?? ($meta['scopes_supported'] ?? []);
        $params = [
            'response_type' => 'code',
            'client_id' => $client['client_id'],
            'redirect_uri' => $redirectUri,
            'state' => $state,
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ];
        if (! empty($scopes)) {
            $params['scope'] = implode(' ', (array) $scopes);
        }

        return add_query_arg(array_map('rawurlencode', $params), $meta['authorization_endpoint']);
    }

    /**
     * Complete an authorization-code exchange from the OAuth callback.
     *
     * @return true|\WP_Error
     */
    public function completeAuthorization(string $code, string $state): bool|\WP_Error
    {
        $pending = get_transient($this->pendingTransientKey($state));
        if (! is_array($pending) || empty($pending['code_verifier'])) {
            return new \WP_Error('oauth_state_invalid', 'OAuth state missing or expired — retry from the connect button.');
        }
        // Bind the pending record to the user that started the flow. Stops
        // user A's in-flight state being completed by a request from user B.
        if ((int) ($pending['user_id'] ?? 0) !== $this->userId) {
            return new \WP_Error('oauth_state_user_mismatch', 'OAuth callback did not match the user that initiated the flow.');
        }
        delete_transient($this->pendingTransientKey($state));

        $meta = $this->getAuthorizationServerMetadata();
        if (is_wp_error($meta)) {
            return $meta;
        }
        $serverMeta = TokenStore::getServerMeta($this->server->name);

        $body = [
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => $pending['redirect_uri'],
            'code_verifier' => $pending['code_verifier'],
        ];
        if (! empty($serverMeta['client_id'])) {
            $body['client_id'] = $serverMeta['client_id'];
        }
        if (! empty($serverMeta['client_secret'])) {
            $body['client_secret'] = $serverMeta['client_secret'];
        }

        $result = $this->postTokenEndpoint($meta['token_endpoint'], $body);
        if (is_wp_error($result)) {
            return $result;
        }

        $this->persistTokenResponse($result);

        return true;
    }

    /* ----------------------------- Internals ------------------------------ */

    /**
     * Load or fetch authorization-server metadata. Cached site-wide in
     * TokenStore so repeat requests are cheap and DCR only runs once per site.
     */
    private function getAuthorizationServerMetadata(): array|\WP_Error
    {
        $stored = TokenStore::getServerMeta($this->server->name);
        if (! empty($stored['auth_endpoint']) && ! empty($stored['token_endpoint'])) {
            return [
                'authorization_endpoint' => $stored['auth_endpoint'],
                'token_endpoint' => $stored['token_endpoint'],
                'registration_endpoint' => $stored['registration_endpoint'] ?? null,
                'scopes_supported' => $stored['scopes_supported'] ?? [],
            ];
        }

        $authServerUrl = $this->discoverAuthorizationServer();
        if (is_wp_error($authServerUrl)) {
            return $authServerUrl;
        }

        $metaUrl = rtrim($authServerUrl, '/').'/.well-known/oauth-authorization-server';
        $response = wp_remote_get($metaUrl, ['timeout' => 10]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) >= 400) {
            // Some providers expose OIDC-style metadata instead.
            $metaUrl = rtrim($authServerUrl, '/').'/.well-known/openid-configuration';
            $response = wp_remote_get($metaUrl, ['timeout' => 10]);
        }
        if (is_wp_error($response)) {
            return $response;
        }
        if (wp_remote_retrieve_response_code($response) >= 400) {
            return new \WP_Error('oauth_metadata_failed', "Failed to load OAuth metadata from {$metaUrl}");
        }
        $meta = json_decode(wp_remote_retrieve_body($response), true);
        if (! is_array($meta) || empty($meta['authorization_endpoint']) || empty($meta['token_endpoint'])) {
            return new \WP_Error('oauth_metadata_invalid', 'OAuth metadata document is missing required endpoints');
        }

        TokenStore::mergeServerMeta($this->server->name, [
            'auth_endpoint' => $meta['authorization_endpoint'],
            'token_endpoint' => $meta['token_endpoint'],
            'registration_endpoint' => $meta['registration_endpoint'] ?? null,
            'scopes_supported' => $meta['scopes_supported'] ?? [],
        ]);

        return $meta;
    }

    /**
     * Find the authorization server for this MCP resource. Uses the newer
     * RFC 9728 protected-resource-metadata discovery when available, falls
     * back to treating the MCP origin as the auth-server origin.
     */
    private function discoverAuthorizationServer(): string|\WP_Error
    {
        $parsed = wp_parse_url($this->server->url);
        if (! $parsed || empty($parsed['host'])) {
            return new \WP_Error('oauth_bad_url', 'Invalid MCP server URL');
        }
        $origin = ($parsed['scheme'] ?? 'https').'://'.$parsed['host'];
        if (! empty($parsed['port'])) {
            $origin .= ':'.$parsed['port'];
        }

        $pathPart = $parsed['path'] ?? '';
        $candidates = [
            $origin.'/.well-known/oauth-protected-resource'.$pathPart,
            $origin.'/.well-known/oauth-protected-resource',
        ];
        foreach ($candidates as $url) {
            $response = wp_remote_get($url, ['timeout' => 10]);
            if (is_wp_error($response) || wp_remote_retrieve_response_code($response) >= 400) {
                continue;
            }
            $data = json_decode(wp_remote_retrieve_body($response), true);
            if (is_array($data) && ! empty($data['authorization_servers'][0])) {
                return (string) $data['authorization_servers'][0];
            }
        }

        return $origin;
    }

    /**
     * Return {client_id, client_secret?} for this server. One registration
     * per site — cached in server meta (wp_options) and shared across users.
     */
    private function ensureClient(array $meta, string $redirectUri): array|\WP_Error
    {
        $stored = TokenStore::getServerMeta($this->server->name);

        // Pre-registered static client from config.
        if (! empty($this->server->auth['client_id'])) {
            TokenStore::mergeServerMeta($this->server->name, [
                'client_id' => $this->server->auth['client_id'],
                'client_secret' => $this->server->auth['client_secret'] ?? null,
            ]);

            return [
                'client_id' => $this->server->auth['client_id'],
                'client_secret' => $this->server->auth['client_secret'] ?? null,
            ];
        }

        if (! empty($stored['client_id'])) {
            return [
                'client_id' => $stored['client_id'],
                'client_secret' => $stored['client_secret'] ?? null,
            ];
        }

        if (empty($meta['registration_endpoint'])) {
            return new \WP_Error(
                'oauth_client_required',
                "MCP server {$this->server->name} does not support dynamic client registration — set auth.client_id (and optionally auth.client_secret) in config.",
            );
        }

        $registration = [
            'client_name' => get_bloginfo('name').' (gds-assistant)',
            'redirect_uris' => [$redirectUri],
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
            'token_endpoint_auth_method' => 'none',
        ];
        if (! empty($this->server->auth['scopes'])) {
            $registration['scope'] = implode(' ', (array) $this->server->auth['scopes']);
        }

        $response = wp_remote_post($meta['registration_endpoint'], [
            'timeout' => 15,
            'headers' => ['Content-Type' => 'application/json', 'Accept' => 'application/json'],
            'body' => wp_json_encode($registration),
        ]);
        if (is_wp_error($response)) {
            return $response;
        }
        if (wp_remote_retrieve_response_code($response) >= 400) {
            return new \WP_Error(
                'oauth_registration_failed',
                'Dynamic client registration failed: '.wp_remote_retrieve_body($response),
            );
        }
        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (! is_array($data) || empty($data['client_id'])) {
            return new \WP_Error('oauth_registration_invalid', 'Registration response missing client_id');
        }

        TokenStore::mergeServerMeta($this->server->name, [
            'client_id' => $data['client_id'],
            'client_secret' => $data['client_secret'] ?? null,
        ]);

        return [
            'client_id' => $data['client_id'],
            'client_secret' => $data['client_secret'] ?? null,
        ];
    }

    private function refreshAccessToken(): ?string
    {
        $tokens = TokenStore::getUserTokens($this->server->name, $this->userId);
        $serverMeta = TokenStore::getServerMeta($this->server->name);
        if (empty($tokens['refresh_token']) || empty($serverMeta['token_endpoint'])) {
            return null;
        }

        $body = [
            'grant_type' => 'refresh_token',
            'refresh_token' => $tokens['refresh_token'],
        ];
        if (! empty($serverMeta['client_id'])) {
            $body['client_id'] = $serverMeta['client_id'];
        }
        if (! empty($serverMeta['client_secret'])) {
            $body['client_secret'] = $serverMeta['client_secret'];
        }

        $result = $this->postTokenEndpoint($serverMeta['token_endpoint'], $body);
        if (is_wp_error($result)) {
            error_log("[gds-assistant] MCP OAuth refresh failed for {$this->server->name} user {$this->userId}: {$result->get_error_message()}");

            return null;
        }

        $this->persistTokenResponse($result);

        return $result['access_token'] ?? null;
    }

    private function postTokenEndpoint(string $url, array $body): array|\WP_Error
    {
        $response = wp_remote_post($url, [
            'timeout' => 15,
            'headers' => [
                'Accept' => 'application/json',
                'Content-Type' => 'application/x-www-form-urlencoded',
            ],
            'body' => $body,
        ]);
        if (is_wp_error($response)) {
            return $response;
        }
        $code = wp_remote_retrieve_response_code($response);
        $data = json_decode(wp_remote_retrieve_body($response), true);
        if ($code >= 400) {
            $err = is_array($data) ? ($data['error_description'] ?? $data['error'] ?? 'unknown_error') : 'unknown_error';

            return new \WP_Error('oauth_token_failed', "Token endpoint error ({$code}): {$err}");
        }
        if (! is_array($data) || empty($data['access_token'])) {
            return new \WP_Error('oauth_token_invalid', 'Token response missing access_token');
        }

        return $data;
    }

    private function persistTokenResponse(array $response): void
    {
        $patch = [
            'access_token' => $response['access_token'],
            'token_type' => $response['token_type'] ?? 'Bearer',
            'scope' => $response['scope'] ?? null,
            'expires_at' => isset($response['expires_in']) ? time() + (int) $response['expires_in'] : 0,
        ];
        // Only overwrite refresh_token if the response includes a new one —
        // some servers omit it on refresh, in which case the old one stays valid.
        if (! empty($response['refresh_token'])) {
            $patch['refresh_token'] = $response['refresh_token'];
        }
        TokenStore::mergeUserTokens($this->server->name, $this->userId, $patch);
    }

    private function pendingTransientKey(string $state): string
    {
        return 'gds_assistant_mcp_oauth_'.$this->server->name.'_'.$state;
    }

    private static function randomUrlSafe(int $bytes): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    private static function pkceChallenge(string $verifier): string
    {
        return rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
    }
}
