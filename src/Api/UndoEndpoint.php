<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Bridge\UndoToolProvider;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Storage\ConversationStore;
use WP_REST_Request;
use WP_REST_Response;

/**
 * REST endpoint behind the per-message "Undo" button.
 *
 * Reverts a single previously-executed action by its audit-log id. Undo is a
 * direct action on a *past* action, not a conversation turn — so it runs no
 * model and returns instantly. Reuses UndoToolProvider so the ownership check +
 * restore + mark-undone logic stays in one place. We then record the undo in
 * the originating conversation (a "↩ Reverted…" note, so it's visible in
 * history and the model stays in sync on the next turn) and in the audit log.
 * The LLM-driven undo tool doesn't go through here — its transcript already
 * captures the action.
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

        // Capture the row up front — undo() clears its snapshot, but we still
        // need its conversation + tool name to record the reversal.
        $row = (new AuditLog)->getById($id);

        $result = (new UndoToolProvider)->executeTool('assistant__undo', ['id' => $id]);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
                'code' => $result->get_error_code(),
            ], 400);
        }

        $this->record($row, $result);

        return new WP_REST_Response($result, 200);
    }

    /**
     * Append a "↩ Reverted…" note to the originating conversation and log the
     * undo to the audit trail.
     *
     * @param  array<string, mixed>|null  $row  The reverted audit row.
     * @param  array<string, mixed>  $result  UndoToolProvider's result.
     */
    private function record(?array $row, array $result): void
    {
        if (! $row) {
            return;
        }

        $userId = get_current_user_id();
        $label = (string) ($result['detail'] ?? '') ?: (string) ($row['tool_name'] ?? 'a previous action');
        $caveats = is_array($result['caveats'] ?? null) ? $result['caveats'] : [];
        $note = '↩ Reverted: '.$label;
        if ($caveats) {
            $note .= ' — '.implode(' ', array_map('strval', $caveats));
        }

        $uuid = (string) ($row['conversation_uuid'] ?? '');

        // Audit the undo itself (not undoable — no snapshot).
        (new AuditLog)->log(
            $uuid,
            $userId,
            'assistant/undo',
            ['id' => (int) ($row['id'] ?? 0), 'reverted' => $row['tool_name'] ?? ''],
            $result,
        );

        // Append the note to the conversation transcript so it shows in history
        // and the model sees it next turn (ChatEndpoint merges consecutive
        // same-role messages, so a trailing user note can't break alternation).
        if ($uuid === '') {
            return;
        }
        $store = new ConversationStore;
        $conversation = $store->get($uuid);
        if (! $conversation || $conversation->userId !== $userId) {
            return;
        }
        $messages = $conversation->messages;
        $messages[] = ['role' => 'user', 'content' => $note];
        $store->update($uuid, ['messages' => $messages]);
    }
}
