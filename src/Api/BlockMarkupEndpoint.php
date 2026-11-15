<?php

namespace GeneroWP\Assistant\Api;

use WP_REST_Request;
use WP_REST_Response;

/**
 * Raw saved block markup of a post, for the chat's post-write validation.
 *
 * Block validity can only be checked in the browser (each block's JS save()
 * runs against the editor's registry), so after a server-side ability writes
 * a post the chat fetches the saved markup here and parses it. Ability results
 * carry only the post id, not its REST route, so this resolves any post type.
 */
class BlockMarkupEndpoint
{
    public function register(): void
    {
        register_rest_route('gds-assistant/v1', '/block-markup/(?P<id>\d+)', [
            'methods' => 'GET',
            'callback' => [$this, 'handle'],
            'permission_callback' => [$this, 'checkPermission'],
            'args' => [
                'id' => ['type' => 'integer', 'required' => true],
            ],
        ]);
    }

    public function checkPermission(WP_REST_Request $request): bool
    {
        return current_user_can(apply_filters('gds-assistant/capability', 'edit_posts'))
            && current_user_can('edit_post', (int) $request->get_param('id'));
    }

    public function handle(WP_REST_Request $request): WP_REST_Response
    {
        $post = get_post((int) $request->get_param('id'));
        if (! $post) {
            return new WP_REST_Response(['error' => 'Post not found'], 404);
        }

        return new WP_REST_Response([
            'id' => $post->ID,
            'type' => $post->post_type,
            'content' => $post->post_content,
        ], 200);
    }
}
