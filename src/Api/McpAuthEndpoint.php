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
            // State param + pending-transient lookup binds the callback to
            // the user that started the flow. We still require a logged-in
            // admin here — the OAuth provider redirects back within the same
            // browser session, so this should always be satisfied.
            'permission_callback' => fn () => current_user_can('manage_options'),
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

    public function callback(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
    {
        $server = ServerRegistry::get($request['name']);
        if (! $server || $server->authType() !== 'oauth') {
            return new \WP_Error('not_found', 'MCP server not configured for OAuth', ['status' => 404]);
        }

        $settingsUrl = admin_url('admin.php?page=gds-assistant');

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

        $userId = get_current_user_id();
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
