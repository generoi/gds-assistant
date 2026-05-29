<?php

namespace GeneroWP\Assistant\Storage\Records;

use GeneroWP\Assistant\Storage\AuditLog;

/**
 * One row from `{$prefix}gds_assistant_audit_log` — a single tool execution
 * recorded for accountability + undo.
 *
 * Returned by {@see AuditLog::getById()},
 * {@see AuditLog::getReversible()}, and {@see AuditLog::getForConversation()}.
 *
 * The `toolInput`, `toolResult` and `undoState` columns are stored as JSON
 * strings in the DB; we decode lazily on read so consumers can poke at
 * them as real arrays. `null` here means the column was NULL on disk —
 * the audit row predates undo support, the action wasn't undoable, or the
 * snapshot exceeded `AuditLog::MAX_UNDO_BYTES` and was dropped before
 * insert. The Undo UI keys on \"have an undo snapshot\" so a null on read
 * is the correct \"can't undo this row\" signal.
 */
final class AuditEntry
{
    /**
     * @param  array<string, mixed>  $toolInput  Decoded tool input shape.
     * @param  array<string, mixed>|string|null  $toolResult  Decoded result; string when the tool returned a raw string (mostly truncated).
     * @param  array<string, mixed>|null  $undoState  Decoded undo snapshot; null when not undoable.
     */
    public function __construct(
        public readonly int $id,
        public readonly string $conversationUuid,
        public readonly int $userId,
        public readonly string $toolName,
        public readonly array $toolInput,
        public readonly array|string|null $toolResult,
        public readonly ?array $undoState,
        public readonly bool $isError,
        public readonly bool $isDestructive,
        public readonly string $createdAt,
    ) {}

    /**
     * Build from a raw `$wpdb->get_row(..., ARRAY_A)` shape. JSON columns are
     * decoded into arrays; failures fall back to null/empty so a single bad
     * row never crashes the read path.
     *
     * @param  array<string, mixed>  $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            id: (int) ($row['id'] ?? 0),
            conversationUuid: (string) ($row['conversation_uuid'] ?? ''),
            userId: (int) ($row['user_id'] ?? 0),
            toolName: (string) ($row['tool_name'] ?? ''),
            toolInput: self::decodeMap($row['tool_input'] ?? null),
            toolResult: self::decodeResult($row['tool_result'] ?? null),
            undoState: self::decodeNullableMap($row['undo_state'] ?? null),
            isError: ! empty($row['is_error']),
            isDestructive: ! empty($row['is_destructive']),
            createdAt: (string) ($row['created_at'] ?? ''),
        );
    }

    /**
     * @return array{
     *     id: int,
     *     conversation_uuid: string,
     *     user_id: int,
     *     tool_name: string,
     *     tool_input: array<string, mixed>,
     *     tool_result: array<string, mixed>|string|null,
     *     undo_state: array<string, mixed>|null,
     *     is_error: bool,
     *     is_destructive: bool,
     *     created_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'conversation_uuid' => $this->conversationUuid,
            'user_id' => $this->userId,
            'tool_name' => $this->toolName,
            'tool_input' => $this->toolInput,
            'tool_result' => $this->toolResult,
            'undo_state' => $this->undoState,
            'is_error' => $this->isError,
            'is_destructive' => $this->isDestructive,
            'created_at' => $this->createdAt,
        ];
    }

    /** @return array<string, mixed> */
    private static function decodeMap(mixed $value): array
    {
        if (! is_string($value) || $value === '') {
            return [];
        }
        $decoded = json_decode($value, true);

        return is_array($decoded) ? $decoded : [];
    }

    /** @return array<string, mixed>|null */
    private static function decodeNullableMap(mixed $value): ?array
    {
        if (! is_string($value) || $value === '') {
            return null;
        }
        $decoded = json_decode($value, true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * `tool_result` is tricky: most rows decode into an array, but oversize
     * results get truncated and stored as `…[truncated]`-suffixed strings.
     * Preserve both shapes — the front-end already handles either.
     *
     * @return array<string, mixed>|string|null
     */
    private static function decodeResult(mixed $value): array|string|null
    {
        if (! is_string($value) || $value === '') {
            return null;
        }
        $decoded = json_decode($value, true);

        return is_array($decoded) ? $decoded : $value;
    }
}
