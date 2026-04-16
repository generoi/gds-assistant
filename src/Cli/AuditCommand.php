<?php

namespace GeneroWP\Assistant\Cli;

use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Storage\ConversationStore;
use WP_CLI;

/**
 * Query the gds-assistant tool-call audit log from the CLI.
 *
 * Every tool the assistant executes is logged to wp_gds_assistant_audit_log
 * with its full input JSON, result, timestamp, conversation UUID, and user
 * ID. These commands let developers inspect that log directly without
 * writing SQL — useful for diagnosing what the LLM actually did during a
 * session (e.g. when a bulk chain of updates produced unexpected state).
 *
 *     wp gds-assistant audit list                    # recent entries
 *     wp gds-assistant audit list --tool=content-create --days=1
 *     wp gds-assistant audit conversations           # recent conversation UUIDs
 *     wp gds-assistant audit show <uuid>             # full transcript
 *     wp gds-assistant audit export <uuid> --format=json
 *
 * Deliberately CLI-only — no admin UI. The audit log can contain sensitive
 * arguments (page content, credentials mistakenly sent as params, etc.) so
 * access is gated on shell-level permissions, not a capability check.
 */
final class AuditCommand
{
    /**
     * Register commands when WP-CLI is loaded. Called from Plugin.php.
     */
    public static function register(): void
    {
        if (defined('WP_CLI') && WP_CLI) {
            WP_CLI::add_command('gds-assistant audit', self::class);
        }
    }

    /**
     * List recent audit log entries.
     *
     * ## OPTIONS
     *
     * [--user=<id>]
     * : Filter to a specific user ID.
     *
     * [--tool=<name>]
     * : Filter by tool name (exact match or SQL LIKE if the value contains %).
     *
     * [--conversation=<uuid>]
     * : Filter to a specific conversation UUID.
     *
     * [--days=<n>]
     * : Only entries from the last N days. Default: 7.
     *
     * [--errors]
     * : Only show entries where is_error = 1.
     *
     * [--limit=<n>]
     * : Maximum rows to return. Default: 50.
     *
     * [--format=<format>]
     * : table, csv, json, count. Default: table.
     *
     * ## EXAMPLES
     *
     *     wp gds-assistant audit list
     *     wp gds-assistant audit list --tool=gds/content-update --days=1
     *     wp gds-assistant audit list --conversation=abc-123 --format=json
     *     wp gds-assistant audit list --errors
     *
     * @subcommand list
     */
    public function list_entries($args, $assoc_args): void
    {
        global $wpdb;

        $conditions = ['1=1'];
        $params = [];

        if (isset($assoc_args['user'])) {
            $conditions[] = 'user_id = %d';
            $params[] = (int) $assoc_args['user'];
        }
        if (isset($assoc_args['conversation'])) {
            $conditions[] = 'conversation_uuid = %s';
            $params[] = $assoc_args['conversation'];
        }
        if (isset($assoc_args['tool'])) {
            if (str_contains($assoc_args['tool'], '%')) {
                $conditions[] = 'tool_name LIKE %s';
            } else {
                $conditions[] = 'tool_name = %s';
            }
            $params[] = $assoc_args['tool'];
        }
        if (isset($assoc_args['errors'])) {
            $conditions[] = 'is_error = 1';
        }

        $days = (int) ($assoc_args['days'] ?? 7);
        if ($days > 0) {
            $conditions[] = 'created_at >= %s';
            $params[] = gmdate('Y-m-d H:i:s', time() - ($days * DAY_IN_SECONDS));
        }

        $limit = (int) ($assoc_args['limit'] ?? 50);
        $params[] = $limit;

        $sql = 'SELECT id, created_at, user_id, conversation_uuid, tool_name, '
            .'LEFT(tool_input, 200) AS input_snippet, is_error, is_destructive '
            .'FROM '.AuditLog::tableName().' '
            .'WHERE '.implode(' AND ', $conditions).' '
            .'ORDER BY created_at DESC LIMIT %d';

        $rows = $wpdb->get_results($wpdb->prepare($sql, $params), ARRAY_A) ?: [];

        $format = $assoc_args['format'] ?? 'table';
        WP_CLI\Utils\format_items(
            $format,
            $rows,
            ['id', 'created_at', 'user_id', 'conversation_uuid', 'tool_name', 'input_snippet', 'is_error'],
        );
    }

    /**
     * List recent conversations by UUID (for use as input to `show`/`export`).
     *
     * ## OPTIONS
     *
     * [--user=<id>]
     * : Filter to a specific user ID.
     *
     * [--days=<n>]
     * : Only conversations with activity in the last N days. Default: 7.
     *
     * [--limit=<n>]
     * : Default: 20.
     *
     * [--format=<format>]
     * : table, csv, json, yaml. Default: table.
     *
     * ## EXAMPLES
     *
     *     wp gds-assistant audit conversations
     *     wp gds-assistant audit conversations --user=1 --days=1
     */
    public function conversations($args, $assoc_args): void
    {
        global $wpdb;

        $conditions = ['1=1'];
        $params = [];

        if (isset($assoc_args['user'])) {
            $conditions[] = 'user_id = %d';
            $params[] = (int) $assoc_args['user'];
        }

        $days = (int) ($assoc_args['days'] ?? 7);
        if ($days > 0) {
            $conditions[] = 'created_at >= %s';
            $params[] = gmdate('Y-m-d H:i:s', time() - ($days * DAY_IN_SECONDS));
        }

        $limit = (int) ($assoc_args['limit'] ?? 20);
        $params[] = $limit;

        $sql = 'SELECT conversation_uuid, user_id, '
            .'COUNT(*) AS tool_calls, '
            .'SUM(is_error) AS errors, '
            .'MIN(created_at) AS first_call, '
            .'MAX(created_at) AS last_call '
            .'FROM '.AuditLog::tableName().' '
            .'WHERE '.implode(' AND ', $conditions).' '
            .'GROUP BY conversation_uuid, user_id '
            .'ORDER BY last_call DESC LIMIT %d';

        $rows = $wpdb->get_results($wpdb->prepare($sql, $params), ARRAY_A) ?: [];

        // Decorate with title from the ConversationStore if available.
        if ($rows) {
            $convTable = ConversationStore::tableName();
            $uuids = array_column($rows, 'conversation_uuid');
            $placeholders = implode(',', array_fill(0, count($uuids), '%s'));
            $titles = $wpdb->get_results(
                $wpdb->prepare(
                    "SELECT uuid, title FROM {$convTable} WHERE uuid IN ({$placeholders})",
                    $uuids,
                ),
                OBJECT_K,
            );
            foreach ($rows as &$row) {
                $row['title'] = $titles[$row['conversation_uuid']]->title ?? '(unknown)';
            }
        }

        $format = $assoc_args['format'] ?? 'table';
        WP_CLI\Utils\format_items(
            $format,
            $rows,
            ['conversation_uuid', 'user_id', 'title', 'tool_calls', 'errors', 'first_call', 'last_call'],
        );
    }

    /**
     * Show a full transcript for a conversation (every tool call, with inputs and results).
     *
     * ## OPTIONS
     *
     * <uuid>
     * : The conversation UUID to fetch.
     *
     * [--truncate=<n>]
     * : Truncate each input/result to N chars. Default: 500. Use 0 for no truncation.
     *
     * ## EXAMPLES
     *
     *     wp gds-assistant audit show abc-123
     *     wp gds-assistant audit show abc-123 --truncate=0
     */
    public function show($args, $assoc_args): void
    {
        [$uuid] = $args;
        $truncate = (int) ($assoc_args['truncate'] ?? 500);

        $rows = (new AuditLog)->getForConversation($uuid);
        if (! $rows) {
            WP_CLI::error("No audit log entries found for conversation {$uuid}.");
        }

        WP_CLI::log(sprintf("Conversation %s — %d tool calls\n", $uuid, count($rows)));

        foreach ($rows as $i => $row) {
            $num = $i + 1;
            $status = $row['is_error'] ? WP_CLI::colorize('%R[ERROR]%n') : WP_CLI::colorize('%G[ok]%n');
            WP_CLI::log(sprintf(
                "\n── %2d. %s  %s  %s",
                $num,
                $row['created_at'],
                $row['tool_name'],
                $status,
            ));

            WP_CLI::log('  input:  '.self::snippet($row['tool_input'], $truncate));
            if ($row['tool_result']) {
                WP_CLI::log('  result: '.self::snippet($row['tool_result'], $truncate));
            }
        }
    }

    /**
     * Export a conversation's audit entries as JSON to stdout.
     *
     * ## OPTIONS
     *
     * <uuid>
     * : The conversation UUID to export.
     *
     * [--format=<format>]
     * : json or yaml. Default: json.
     *
     * ## EXAMPLES
     *
     *     wp gds-assistant audit export abc-123 > debug.json
     *     wp gds-assistant audit export abc-123 --format=yaml
     */
    public function export($args, $assoc_args): void
    {
        [$uuid] = $args;
        $format = $assoc_args['format'] ?? 'json';

        $rows = (new AuditLog)->getForConversation($uuid);
        if (! $rows) {
            WP_CLI::error("No audit log entries found for conversation {$uuid}.");
        }

        $decoded = array_map(function (array $r) {
            $r['tool_input'] = json_decode($r['tool_input'], true);
            $r['tool_result'] = $r['tool_result'] !== null ? json_decode($r['tool_result'], true) : null;
            $r['is_error'] = (bool) $r['is_error'];
            $r['is_destructive'] = (bool) $r['is_destructive'];

            return $r;
        }, $rows);

        if ($format === 'yaml') {
            WP_CLI::log(WP_CLI\Utils\format_items('yaml', $decoded, array_keys($decoded[0])));

            return;
        }

        WP_CLI::log(json_encode($decoded, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private static function snippet(string $raw, int $truncate): string
    {
        if ($truncate === 0 || strlen($raw) <= $truncate) {
            return $raw;
        }

        return substr($raw, 0, $truncate).'… ['.(strlen($raw) - $truncate).' more chars]';
    }
}
