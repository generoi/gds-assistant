<?php

namespace GeneroWP\Assistant\Storage;

class AuditLog
{
    public static function tableName(): string
    {
        global $wpdb;

        return $wpdb->prefix.'gds_assistant_audit_log';
    }

    /** Bump when the schema changes so existing installs migrate via dbDelta. */
    private const DB_VERSION = 2;

    private const DB_VERSION_OPTION = 'gds_assistant_audit_db_version';

    /** Max bytes of an undo snapshot to store; larger objects simply aren't undoable. */
    private const MAX_UNDO_BYTES = 256000;

    public static function createTables(): void
    {
        global $wpdb;

        $table = self::tableName();
        $charset = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE $table (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            conversation_uuid char(36) NOT NULL,
            user_id bigint(20) unsigned NOT NULL,
            tool_name varchar(255) NOT NULL,
            tool_input longtext NOT NULL,
            tool_result longtext DEFAULT NULL,
            undo_state longtext DEFAULT NULL,
            is_error tinyint(1) DEFAULT 0,
            is_destructive tinyint(1) DEFAULT 0,
            created_at datetime NOT NULL,
            PRIMARY KEY  (id),
            KEY idx_user_created (user_id, created_at),
            KEY idx_conversation (conversation_uuid)
        ) $charset;";

        require_once ABSPATH.'wp-admin/includes/upgrade.php';
        dbDelta($sql);

        update_option(self::DB_VERSION_OPTION, self::DB_VERSION);
    }

    /**
     * Run pending schema migrations on existing installs (cheap version gate).
     */
    public static function maybeUpgrade(): void
    {
        if ((int) get_option(self::DB_VERSION_OPTION, 0) < self::DB_VERSION) {
            self::createTables();
        }
    }

    /**
     * @param  array<string, mixed>  $input
     * @param  array<string, mixed>|null  $undoState
     * @return array<string, mixed>
     */
    public function log(
        string $conversationUuid,
        int $userId,
        string $toolName,
        array $input,
        mixed $result,
        bool $isError = false,
        bool $isDestructive = false,
        ?array $undoState = null,
    ): array {
        global $wpdb;

        $resultJson = null;
        if ($result !== null) {
            $resultJson = is_wp_error($result)
                ? json_encode(['error' => $result->get_error_message()])
                : json_encode($result);

            // Cap stored result size at 100KB
            if (strlen($resultJson) > 100000) {
                $resultJson = substr($resultJson, 0, 100000).'...[truncated]';
            }
        }

        // Store the undo snapshot if it fits; oversized objects are left
        // non-undoable rather than bloating the table.
        $undoJson = null;
        if ($undoState !== null) {
            $candidate = json_encode($undoState);
            if ($candidate !== false && strlen($candidate) <= self::MAX_UNDO_BYTES) {
                $undoJson = $candidate;
            }
        }

        $wpdb->insert(self::tableName(), [
            'conversation_uuid' => $conversationUuid,
            'user_id' => $userId,
            'tool_name' => $toolName,
            'tool_input' => json_encode($input),
            'tool_result' => $resultJson,
            'undo_state' => $undoJson,
            'is_error' => (int) $isError,
            'is_destructive' => (int) $isDestructive,
            'created_at' => current_time('mysql', true),
        ]);

        do_action('gds-assistant/tool_executed', $toolName, $input, $result, $userId);

        // Return the new row id + whether an undo snapshot was actually stored
        // (it may be dropped if oversized), so the chat can show an Undo button.
        return ['id' => (int) $wpdb->insert_id, 'undoable' => $undoJson !== null];
    }

    /**
     * Fetch a single audit entry by id.
     *
     * @return array<string, mixed>|null
     */
    public function getById(int $id): ?array
    {
        global $wpdb;

        $row = $wpdb->get_row(
            $wpdb->prepare('SELECT * FROM '.self::tableName().' WHERE id = %d', $id),
            ARRAY_A,
        );

        return $row ?: null;
    }

    /**
     * Recent undoable actions for a user (most recent first), newest writes
     * that still carry an undo snapshot.
     *
     * @return array<int, array<string, mixed>>
     */
    public function getReversible(int $userId, int $limit = 10): array
    {
        global $wpdb;

        return $wpdb->get_results(
            $wpdb->prepare(
                'SELECT id, tool_name, undo_state, created_at FROM '.self::tableName().
                ' WHERE user_id = %d AND undo_state IS NOT NULL AND is_error = 0'.
                ' ORDER BY id DESC LIMIT %d',
                $userId,
                $limit,
            ),
            ARRAY_A,
        ) ?: [];
    }

    /**
     * Clear an entry's undo snapshot once it has been applied, so the same
     * action can't be undone twice and it drops off the undoable list.
     */
    public function markUndone(int $id): void
    {
        global $wpdb;

        $wpdb->update(self::tableName(), ['undo_state' => null], ['id' => $id]);
    }

    /** @return array<int, array<string, mixed>> */
    public function getForConversation(string $uuid): array
    {
        global $wpdb;

        return $wpdb->get_results(
            $wpdb->prepare(
                'SELECT * FROM '.self::tableName().' WHERE conversation_uuid = %s ORDER BY created_at ASC',
                $uuid,
            ),
            ARRAY_A,
        ) ?: [];
    }

    /**
     * Delete audit logs older than $days.
     */
    public function prune(int $days): int
    {
        global $wpdb;

        $cutoff = gmdate('Y-m-d H:i:s', time() - ($days * DAY_IN_SECONDS));

        return (int) $wpdb->query(
            $wpdb->prepare(
                'DELETE FROM '.self::tableName().' WHERE created_at < %s',
                $cutoff,
            ),
        );
    }
}
