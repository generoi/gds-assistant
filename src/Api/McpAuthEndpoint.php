<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Mcp\OAuthAuth;
use GeneroWP\Assistant\Mcp\ServerRegistry;
use GeneroWP\Assistant\Mcp\TokenStore;

/**
 * REST endpoints for the MCP OAuth dance. Tokens are per-user, so the
 * connect/disconnect/callback flow runs scoped to the logged-in user.
 *
 * We use WP REST (not admin-post) so the redirect_uri stays stable and
 * doesn't leak an `action=` query arg that some OAuth servers strip.
 *
 *   POST /gds-assistant/v1/mcp/{name}/connect    — starts the flow
 *   GET  /gds-assistant/v1/mcp/{name}/callback   — OAuth redirect target
 *   POST /gds-assistant/v1/mcp/{name}/disconnect — clear this user's tokens
 */
class McpAuthEndpoint
{
    public function register(): void
    {
        register_rest_route('gds-assistant/v1', '/mcp/servers', [
            [
                'methods' => \WP_REST_Server::READABLE,
                'callback' => [$this, 'listServers'],
                'permission_callback' => fn () => current_user_can('manage_options'),
            ],
            [
                'methods' => \WP_REST_Server::CREATABLE,
                'callback' => [$this, 'createServer'],
                'permission_callback' => fn () => current_user_can('manage_options'),
            ],
        ]);

        register_rest_route('gds-assistant/v1', '/mcp/servers/(?P<name>[a-z0-9_]+)', [
            'methods' => \WP_REST_Server::DELETABLE,
            'callback' => [$this, 'deleteServer'],
            'permission_callback' => fn () => current_user_can('manage_options'),
            'args' => [
                'name' => ['required' => true, 'sanitize_callback' => 'sanitize_key'],
            ],
        ]);

        register_rest_route('gds-assistant/v1', '/mcp/(?P<name>[a-z0-9_]+)/connect', [
            'methods' => \WP_REST_Server::CREATABLE,
            'callback' => [$this, 'connect'],
            'permission_callback' => fn () => current_user_can('manage_options'),
            'args' => [
                'name' => ['required' => true, 'sanitize_callback' => 'sanitize_key'],
            ],
        ]);

        register_rest_route('gds-assistant/v1', '/mcp/(?P<name>[a-z0-9_]+)/callback', [
            'methods' => \WP_REST_Server::READABLE,
            'callback' => [$this, 'callback'],
            // OAuth callback is a top-level browser redirect from the
            // upstream provider (Asana etc.). WP REST's standard cookie
            // auth requires an X-WP-Nonce header which a cross-site
            // navigation can't carry, so current_user_can returns false
            // even for logged-in admins. Authenticate via the logged-in
            // cookie directly — CSRF is covered by the OAuth `state`
            // parameter (bound to user_id in the pending transient).
            'permission_callback' => [$this, 'callbackPermission'],
            'args' => [
                'name' => ['required' => true, 'sanitize_callback' => 'sanitize_key'],
            ],
        ]);

        register_rest_route('gds-assistant/v1', '/mcp/(?P<name>[a-z0-9_]+)/disconnect', [
            'methods' => \WP_REST_Server::CREATABLE,
            'callback' => [$this, 'disconnect'],
            'permission_callback' => fn () => current_user_can('manage_options'),
            'args' => [
                'name' => ['required' => true, 'sanitize_callback' => 'sanitize_key'],
            ],
        ]);
    }

    /**
     * GET /mcp/servers — lists every configured server with the current
     * user's connection status. Used by the MCP Servers DataView admin page.
     */
    public function listServers(): \WP_REST_Response
    {
        $userId = get_current_user_id();
        $out = [];

        // Synthetic built-in entry so admins see the local gds-mcp tools
        // alongside remote ones. Read-only, no connect needed.
        if (defined('GDS_MCP_VERSION') || function_exists('gds_mcp_init') || self::gdsMcpActive()) {
            $out[] = [
                'id' => 'gds-mcp',
                'name' => 'gds-mcp',
                'label' => 'GDS MCP (built-in)',
                'url' => home_url(),
                'auth_type' => 'none',
                'enabled' => true,
                'connected' => true,
                'requires_oauth' => false,
                'callback_url' => null,
                'origin' => 'builtin',
                'deletable' => false,
            ];
        }

        foreach (ServerRegistry::entries() as $entry) {
            $server = $entry['config'];
            $origin = $entry['origin'];
            $authType = $server->authType();
            $connected = $authType === 'oauth'
                ? TokenStore::userHasToken($server->name, $userId)
                : true;

            $row = [
                'id' => $server->name,
                'name' => $server->name,
                'label' => $server->displayLabel(),
                'url' => $server->url,
                'auth_type' => $authType,
                'enabled' => $server->enabled,
                'connected' => $connected,
                'requires_oauth' => $authType === 'oauth',
                'callback_url' => $authType === 'oauth' ? self::callbackUrl($server->name) : null,
                'origin' => $origin,
                'deletable' => $origin === 'admin',
                'editable' => $origin === 'admin',
            ];

            // For admin-origin servers, expose the non-secret auth fields so
            // the DataView can pre-fill the edit modal. client_secret is never
            // returned — the modal shows a placeholder and the backend keeps
            // the stored value if the client submits an empty string.
            if ($origin === 'admin') {
                $row['auth_detail'] = [
                    'type' => $authType,
                    'scopes' => $server->auth['scopes'] ?? [],
                    'client_id' => $server->auth['client_id'] ?? '',
                    'has_client_secret' => ! empty($server->auth['client_secret']),
                    'env' => $server->auth['env'] ?? '',
                ];
            }

            $out[] = $row;
        }

        return new \WP_REST_Response($out);
    }

    /**
     * POST /mcp/servers — add a server via the admin UI. Body:
     *   name, url, label?, auth: {type, scopes?, env?, token?}
     */
    public function createServer(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
    {
        $name = sanitize_key((string) $request->get_param('name'));
        $url = esc_url_raw((string) $request->get_param('url'));
        $label = $request->get_param('label');
        $label = is_string($label) ? sanitize_text_field($label) : null;
        $authParam = $request->get_param('auth');
        $auth = is_array($authParam) ? $authParam : ['type' => 'none'];

        // Only whitelist expected keys in the auth array.
        $auth = array_intersect_key($auth, array_flip(['type', 'scopes', 'env', 'token', 'client_id', 'client_secret']));
        if (! empty($auth['type'])) {
            $auth['type'] = sanitize_key((string) $auth['type']);
        }
        if (! empty($auth['env'])) {
            $auth['env'] = preg_replace('/[^A-Z0-9_]/', '', strtoupper((string) $auth['env']));
        }
        if (isset($auth['scopes']) && is_array($auth['scopes'])) {
            $auth['scopes'] = array_values(array_filter(array_map('sanitize_text_field', $auth['scopes'])));
        }

        $result = ServerRegistry::upsertAdminServer($name, [
            'url' => $url,
            'label' => $label,
            'auth' => $auth,
        ]);
        if (is_wp_error($result)) {
            $result->add_data(['status' => 400]);

            return $result;
        }

        return new \WP_REST_Response(['created' => true, 'name' => $name], 201);
    }

    /**
     * DELETE /mcp/servers/{name} — remove an admin-added server. Can't
     * delete filter/env-configured servers — those are owned by code.
     */
    public function deleteServer(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
    {
        $name = $request['name'];
        $userId = get_current_user_id();

        // Also drop this user's tokens for the server, so the disconnect
        // is complete rather than leaving orphan meta.
        TokenStore::deleteUserTokens($name, $userId);
        self::clearToolsCache($name, $userId);

        $result = ServerRegistry::deleteAdminServer($name);
        if (is_wp_error($result)) {
            $result->add_data(['status' => $result->get_error_code() === 'not_found' ? 404 : 400]);

            return $result;
        }

        return new \WP_REST_Response(['deleted' => true]);
    }

    /** Best-effort check that the gds-mcp plugin is active. */
    private static function gdsMcpActive(): bool
    {
        if (! function_exists('is_plugin_active')) {
            require_once ABSPATH.'wp-admin/includes/plugin.php';
        }

        return is_plugin_active('gds-mcp/gds-mcp.php');
    }

    public function connect(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
    {
        $server = ServerRegistry::get($request['name']);
        if (! $server || $server->authType() !== 'oauth') {
            return new \WP_Error('not_found', 'MCP server not configured for OAuth', ['status' => 404]);
        }

        $userId = get_current_user_id();
        $auth = new OAuthAuth($server, $userId);
        $redirectUri = self::callbackUrl($server->name);
        $url = $auth->startAuthorization($redirectUri);
        if (is_wp_error($url)) {
            return $url;
        }

        self::clearToolsCache($server->name, $userId);

        return new \WP_REST_Response(['authorization_url' => $url]);
    }

    /**
     * Permission callback for the OAuth return URL. Uses
     * wp_validate_auth_cookie directly so we skip WP REST's mandatory
     * X-WP-Nonce check — a top-level browser redirect from the upstream
     * OAuth provider can't carry a nonce, so the standard cookie+nonce
     * check fails and current_user_can() returns false for an otherwise-
     * logged-in admin.
     *
     * CSRF safety: the OAuth `state` parameter is bound to the user_id
     * in the pending transient (OAuthAuth::startAuthorization). The
     * callback handler refuses to exchange a code when the state's
     * user_id doesn't match the cookie-resolved user_id.
     */
    public function callbackPermission(): bool
    {
        $userId = wp_validate_auth_cookie('', 'logged_in');
        if (! $userId) {
            return false;
        }

        return user_can($userId, 'manage_options');
    }

    public function callback(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
    {
        $server = ServerRegistry::get($request['name']);
        if (! $server || $server->authType() !== 'oauth') {
            return new \WP_Error('not_found', 'MCP server not configured for OAuth', ['status' => 404]);
        }

        $settingsUrl = admin_url('admin.php?page=gds-assistant-mcp');

        if ($error = $request->get_param('error')) {
            $desc = $request->get_param('error_description') ?: $error;
            wp_safe_redirect(add_query_arg(['mcp_connect' => 'error', 'mcp_msg' => rawurlencode($desc)], $settingsUrl));
            exit;
        }

        $code = $request->get_param('code');
        $state = $request->get_param('state');
        if (! $code || ! $state) {
            return new \WP_Error('bad_request', 'Missing code or state', ['status' => 400]);
        }

        // Resolve the user via the logged-in cookie rather than
        // get_current_user_id(), which may return 0 here because REST's
        // cookie auth path bailed out on the missing nonce.
        $userId = (int) wp_validate_auth_cookie('', 'logged_in');
        if (! $userId) {
            $userId = get_current_user_id();
        }
        $auth = new OAuthAuth($server, $userId);
        $result = $auth->completeAuthorization($code, $state);
        if (is_wp_error($result)) {
            wp_safe_redirect(add_query_arg([
                'mcp_connect' => 'error',
                'mcp_msg' => rawurlencode($result->get_error_message()),
            ], $settingsUrl));
            exit;
        }

        self::clearToolsCache($server->name, $userId);

        wp_safe_redirect(add_query_arg(['mcp_connect' => 'success'], $settingsUrl));
        exit;
    }

    public function disconnect(\WP_REST_Request $request): \WP_REST_Response
    {
        $name = $request['name'];
        $userId = get_current_user_id();
        TokenStore::deleteUserTokens($name, $userId);
        self::clearToolsCache($name, $userId);

        return new \WP_REST_Response(['disconnected' => true]);
    }

    public static function callbackUrl(string $serverName): string
    {
        return rest_url("gds-assistant/v1/mcp/{$serverName}/callback");
    }

    private static function clearToolsCache(string $serverName, int $userId): void
    {
        delete_transient('gds_assistant_mcp_tools_'.$serverName.'_u'.$userId);
    }
}
