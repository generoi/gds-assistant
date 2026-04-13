<?php

namespace GeneroWP\Assistant\Storage;

class AuditLog
{
    public static function tableName(): string
    {
        global $wpdb;

        return $wpdb->prefix.'gds_assistant_audit_log';
    }

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
            is_error tinyint(1) DEFAULT 0,
            is_destructive tinyint(1) DEFAULT 0,
            created_at datetime NOT NULL,
            PRIMARY KEY  (id),
            KEY idx_user_created (user_id, created_at),
            KEY idx_conversation (conversation_uuid)
        ) $charset;";

        require_once ABSPATH.'wp-admin/includes/upgrade.php';
        dbDelta($sql);
    }

    public function log(
        string $conversationUuid,
        int $userId,
        string $toolName,
        array $input,
        mixed $result,
        bool $isError = false,
        bool $isDestructive = false,
    ): void {
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

        $wpdb->insert(self::tableName(), [
            'conversation_uuid' => $conversationUuid,
            'user_id' => $userId,
            'tool_name' => $toolName,
            'tool_input' => json_encode($input),
            'tool_result' => $resultJson,
            'is_error' => (int) $isError,
            'is_destructive' => (int) $isDestructive,
            'created_at' => current_time('mysql', true),
        ]);

        do_action('gds-assistant/tool_executed', $toolName, $input, $result, $userId);
    }

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
