<?php

namespace GeneroWP\Assistant\Bridge;

use GeneroWP\Assistant\Storage\AuditLog;

/**
 * Chat-facing undo. Lists recent undoable actions and replays a stored
 * snapshot to revert one. The snapshot itself never travels through the LLM —
 * it's loaded from the audit log here and handed to gds-mcp's
 * `gds-mcp/restore_snapshot` filter server-side.
 *
 * A user can only undo their own actions (the audit row's user_id must match),
 * which also scopes capability: an editor never sees an admin's form-edit
 * entries, so they can't restore something they couldn't have done.
 */
class UndoToolProvider implements ToolProviderInterface
{
    private const PREFIX = 'assistant__undo';

    public function getTools(): array
    {
        return [
            [
                'name' => 'assistant__undo-list',
                'description' => 'List recent actions that can be undone (most recent first), each with an id and a description of what undoing it would do. Use before assistant__undo to pick the right entry.',
                'input_schema' => ['type' => 'object', 'properties' => (object) []],
            ],
            [
                'name' => 'assistant__undo',
                'description' => 'Undo a previous change by restoring its saved before-state — revert an edit, restore a form to its prior version, untrash a deleted item, re-link translations, etc. Pass the id from assistant__undo-list, or omit it to undo your most recent undoable action. Only your own actions can be undone. IMPORTANT: read the returned "caveats" — some undos (e.g. recreating a deleted term) restore the data under a NEW id, so references elsewhere may still point at the old one; relay those caveats to the user.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'integer', 'description' => 'Audit entry id from assistant__undo-list. Omit to undo your most recent undoable action.'],
                    ],
                ],
            ],
        ];
    }

    public function executeTool(string $name, array $input): mixed
    {
        $capability = apply_filters('gds-assistant/capability', 'edit_posts');
        if (! current_user_can($capability)) {
            return new \WP_Error('forbidden', 'Insufficient permissions');
        }

        return match ($name) {
            'assistant__undo-list' => $this->listUndoable(),
            'assistant__undo' => $this->undo($input),
            default => new \WP_Error('unknown_tool', "Unknown tool: {$name}"),
        };
    }

    public function handles(string $name): bool
    {
        return str_starts_with($name, self::PREFIX);
    }

    /** @return array<int, array<string, mixed>> */
    private function listUndoable(): array
    {
        $rows = (new AuditLog)->getReversible(get_current_user_id(), 10);

        return array_map(static function ($row) {
            $undo = $row->undoState ?? [];

            return [
                'id' => $row->id,
                'action' => $row->toolName,
                'undo' => $undo['label'] ?? 'Restore previous state',
                'when' => $row->createdAt,
            ];
        }, $rows);
    }

    /**
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>|\WP_Error
     */
    private function undo(array $input): array|\WP_Error
    {
        $log = new AuditLog;
        $userId = get_current_user_id();

        $id = (int) ($input['id'] ?? 0);
        if ($id) {
            $row = $log->getById($id);
            if (! $row || $row->userId !== $userId) {
                return new \WP_Error('not_found', 'No undoable action with that id (or it is not yours).');
            }
        } else {
            $row = $log->getReversible($userId, 1)[0] ?? null;
            if (! $row) {
                return new \WP_Error('nothing_to_undo', 'There is no recent action to undo.');
            }
        }

        $snapshot = $row->undoState;
        if (! $snapshot || empty($snapshot['kind'])) {
            return new \WP_Error('not_undoable', 'That action can no longer be undone.');
        }

        $result = apply_filters('gds-mcp/restore_snapshot', null, $snapshot);
        if (is_wp_error($result)) {
            return $result;
        }
        if (! is_array($result)) {
            return new \WP_Error('undo_unavailable', 'No restore handler is available (is gds-mcp active?).');
        }

        // Prevent double-undo: clear the snapshot now it's been applied.
        $log->markUndone($row->id);

        return [
            'undone' => true,
            'action' => $row->toolName,
            'detail' => $snapshot['label'] ?? '',
            'caveats' => $result['caveats'] ?? [],
            'result' => $result,
        ];
    }
}
