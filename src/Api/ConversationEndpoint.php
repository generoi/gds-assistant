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
                'methods' => 'POST',
                'callback' => [$this, 'update'],
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

    public function list(WP_REST_Request $request): WP_REST_Response
    {
        $store = new ConversationStore;
        $showAll = $request->get_param('all') && current_user_can('manage_options');

        if ($showAll) {
            $conversations = $store->listAll(archived: false);
        } else {
            $conversations = $store->listForUser(get_current_user_id(), archived: false);
        }

        // Enrich with user display names
        $userCache = [];
        foreach ($conversations as &$conv) {
            $uid = (int) ($conv['user_id'] ?? 0);
            if ($uid && ! isset($userCache[$uid])) {
                $user = get_userdata($uid);
                $userCache[$uid] = $user ? $user->display_name : "User #{$uid}";
            }
            $conv['user_name'] = $userCache[$uid] ?? '';
        }

        return new WP_REST_Response($conversations);
    }

    public function get(WP_REST_Request $request): WP_REST_Response
    {
        $store = new ConversationStore;
        $conversation = $store->get($request->get_param('uuid'));

        if (! $conversation) {
            return new WP_REST_Response(['error' => 'Not found'], 404);
        }
        if ((int) $conversation['user_id'] !== get_current_user_id() && ! current_user_can('manage_options')) {
            return new WP_REST_Response(['error' => 'Forbidden'], 403);
        }

        return new WP_REST_Response($conversation);
    }

    public function update(WP_REST_Request $request): WP_REST_Response
    {
        $store = new ConversationStore;
        $uuid = $request->get_param('uuid');
        $conversation = $store->get($uuid);

        if (! $conversation) {
            return new WP_REST_Response(['error' => 'Not found'], 404);
        }
        if ((int) $conversation['user_id'] !== get_current_user_id() && ! current_user_can('manage_options')) {
            return new WP_REST_Response(['error' => 'Forbidden'], 403);
        }

        $data = [];
        if ($request->has_param('archived')) {
            $data['archived'] = (bool) $request->get_param('archived') ? 1 : 0;
        }

        if (! empty($data)) {
            $store->update($uuid, $data);
        }

        return new WP_REST_Response(['updated' => true]);
    }

    public function delete(WP_REST_Request $request): WP_REST_Response
    {
        // Soft delete = archive (conversations should never be truly deleted)
        $store = new ConversationStore;
        $uuid = $request->get_param('uuid');
        $conversation = $store->get($uuid);

        if (! $conversation) {
            return new WP_REST_Response(['error' => 'Not found'], 404);
        }
        if ((int) $conversation['user_id'] !== get_current_user_id() && ! current_user_can('manage_options')) {
            return new WP_REST_Response(['error' => 'Forbidden'], 403);
        }

        $store->update($uuid, ['archived' => 1]);

        return new WP_REST_Response(['archived' => true]);
    }
}
