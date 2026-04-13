<?php

namespace GeneroWP\Assistant\Storage;

class ConversationStore
{
    public static function tableName(): string
    {
        global $wpdb;

        return $wpdb->prefix.'gds_assistant_conversations';
    }

    public static function createTables(): void
    {
        global $wpdb;

        $table = self::tableName();
        $charset = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE $table (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            uuid char(36) NOT NULL,
            user_id bigint(20) unsigned NOT NULL,
            title varchar(255) DEFAULT '',
            messages longtext NOT NULL,
            summary text DEFAULT '',
            model varchar(100) NOT NULL DEFAULT '',
            total_input_tokens int unsigned DEFAULT 0,
            total_output_tokens int unsigned DEFAULT 0,
            created_at datetime NOT NULL,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY uuid (uuid),
            KEY idx_user_updated (user_id, updated_at)
        ) $charset;";

        require_once ABSPATH.'wp-admin/includes/upgrade.php';
        dbDelta($sql);
    }

    public function create(int $userId, string $model = ''): string
    {
        global $wpdb;

        $uuid = wp_generate_uuid4();
        $now = current_time('mysql', true);

        $wpdb->insert(self::tableName(), [
            'uuid' => $uuid,
            'user_id' => $userId,
            'title' => '',
            'messages' => '[]',
            'model' => $model,
            'total_input_tokens' => 0,
            'total_output_tokens' => 0,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $uuid;
    }

    public function get(string $uuid): ?array
    {
        global $wpdb;

        $row = $wpdb->get_row(
            $wpdb->prepare(
                'SELECT * FROM '.self::tableName().' WHERE uuid = %s',
                $uuid,
            ),
            ARRAY_A,
        );

        if (! $row) {
            return null;
        }

        $row['messages'] = json_decode($row['messages'], true) ?: [];

        return $row;
    }

    public function update(string $uuid, array $data): bool
    {
        global $wpdb;

        $update = [];
        if (isset($data['messages'])) {
            $update['messages'] = json_encode($data['messages']);
        }
        if (isset($data['title'])) {
            $update['title'] = $data['title'];
        }
        if (isset($data['total_input_tokens'])) {
            $update['total_input_tokens'] = $data['total_input_tokens'];
        }
        if (isset($data['total_output_tokens'])) {
            $update['total_output_tokens'] = $data['total_output_tokens'];
        }
        if (isset($data['summary'])) {
            $update['summary'] = $data['summary'];
        }

        $update['updated_at'] = current_time('mysql', true);

        return (bool) $wpdb->update(
            self::tableName(),
            $update,
            ['uuid' => $uuid],
        );
    }

    public function listForUser(int $userId, int $limit = 20, int $offset = 0): array
    {
        global $wpdb;

        return $wpdb->get_results(
            $wpdb->prepare(
                'SELECT uuid, title, model, total_input_tokens, total_output_tokens, created_at, updated_at
                FROM '.self::tableName().'
                WHERE user_id = %d
                ORDER BY updated_at DESC
                LIMIT %d OFFSET %d',
                $userId,
                $limit,
                $offset,
            ),
            ARRAY_A,
        ) ?: [];
    }

    public function delete(string $uuid, int $userId): bool
    {
        global $wpdb;

        return (bool) $wpdb->delete(self::tableName(), [
            'uuid' => $uuid,
            'user_id' => $userId,
        ]);
    }

    /**
     * Delete conversations older than $days for all users.
     */
    public function prune(int $days): int
    {
        global $wpdb;

        $cutoff = gmdate('Y-m-d H:i:s', time() - ($days * DAY_IN_SECONDS));

        return (int) $wpdb->query(
            $wpdb->prepare(
                'DELETE FROM '.self::tableName().' WHERE updated_at < %s',
                $cutoff,
            ),
        );
    }
}
