<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Plugin;
use GeneroWP\Assistant\Storage\ConversationStore;
use WP_REST_Request;
use WP_REST_Response;

class ConversationEndpoint
{
    public function __construct(
        private readonly Plugin $plugin,
    ) {}

    public function register(): void
    {
        register_rest_route('gds-assistant/v1', '/conversations', [
            'methods' => 'GET',
            'callback' => [$this, 'list'],
            'permission_callback' => [$this, 'checkPermission'],
        ]);

        register_rest_route('gds-assistant/v1', '/conversations/(?P<uuid>[a-f0-9-]+)', [
            [
                'methods' => 'GET',
                'callback' => [$this, 'get'],
                'permission_callback' => [$this, 'checkPermission'],
            ],
            [
                'methods' => 'DELETE',
                'callback' => [$this, 'delete'],
                'permission_callback' => [$this, 'checkPermission'],
            ],
        ]);
    }

    public function checkPermission(): bool
    {
        $capability = apply_filters('gds-assistant/capability', 'edit_posts');

        return current_user_can($capability);
    }

    public function list(): WP_REST_Response
    {
        $store = new ConversationStore;
        $conversations = $store->listForUser(get_current_user_id());

        return new WP_REST_Response($conversations);
    }

    public function get(WP_REST_Request $request): WP_REST_Response
    {
        $store = new ConversationStore;
        $conversation = $store->get($request->get_param('uuid'));

        if (! $conversation || (int) $conversation['user_id'] !== get_current_user_id()) {
            return new WP_REST_Response(['error' => 'Not found'], 404);
        }

        return new WP_REST_Response($conversation);
    }

    public function delete(WP_REST_Request $request): WP_REST_Response
    {
        $store = new ConversationStore;
        $deleted = $store->delete($request->get_param('uuid'), get_current_user_id());

        if (! $deleted) {
            return new WP_REST_Response(['error' => 'Not found'], 404);
        }

        return new WP_REST_Response(['deleted' => true]);
    }
}
