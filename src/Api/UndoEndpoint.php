<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Bridge\UndoToolProvider;
use WP_REST_Request;
use WP_REST_Response;

/**
 * REST endpoint behind the per-message "Undo" button.
 *
 * Reverts a single previously-executed action by its audit-log id. Undo is a
 * direct action on a *past* action, not a conversation turn — so it runs no
 * model, adds nothing to the transcript, and returns instantly. Reuses
 * UndoToolProvider so the ownership check + restore + mark-undone logic stays
 * in one place.
 */
class UndoEndpoint
{
    public function register(): void
    {
        register_rest_route('gds-assistant/v1', '/undo', [
            'methods' => 'POST',
            'callback' => [$this, 'handle'],
            'permission_callback' => [$this, 'checkPermission'],
            'args' => [
                'id' => ['type' => 'integer', 'required' => true],
            ],
        ]);
    }

    public function checkPermission(): bool
    {
        return current_user_can(apply_filters('gds-assistant/capability', 'edit_posts'));
    }

    public function handle(WP_REST_Request $request): WP_REST_Response
    {
        $id = (int) $request->get_param('id');
        $result = (new UndoToolProvider)->executeTool('assistant__undo', ['id' => $id]);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
                'code' => $result->get_error_code(),
            ], 400);
        }

        return new WP_REST_Response($result, 200);
    }
}
