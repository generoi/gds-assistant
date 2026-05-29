<?php

namespace GeneroWP\Assistant\Storage\Records;

use GeneroWP\Assistant\Storage\ConversationStore;

/**
 * One row from `{$prefix}gds_assistant_conversations` — the persistent state
 * of a single chat thread.
 *
 * Returned by {@see ConversationStore::get()} and the list helpers
 * ({@see ConversationStore::listForUser()}, {@see ConversationStore::listAll()}).
 * The `messages` column is JSON in the DB; we decode lazily on read so
 * consumers get a real list, not a string.
 *
 * Records cross the REST API boundary (the front-end loads conversations
 * via `/gds-assistant/v1/conversations`), so the wire shape lives in
 * {@see self::toArray()}; older rows without one of the newer columns
 * (e.g. `archived`, `summary` on installs that haven't run the migration)
 * deserialise via {@see self::fromRow()} with reasonable defaults.
 */
final class ConversationRecord
{
    /**
     * @param  list<array<string, mixed>>  $messages  Decoded message list (each: {role, content, ...}).
     */
    public function __construct(
        public readonly int $id,
        public readonly string $uuid,
        public readonly int $userId,
        public readonly string $title,
        public readonly array $messages,
        public readonly string $summary,
        public readonly string $model,
        public readonly bool $archived,
        public readonly int $totalInputTokens,
        public readonly int $totalOutputTokens,
        public readonly string $createdAt,
        public readonly string $updatedAt,
    ) {}

    /**
     * Build from a raw `$wpdb->get_row(..., ARRAY_A)` shape.
     *
     * @param  array<string, mixed>  $row
     */
    public static function fromRow(array $row): self
    {
        $messages = $row['messages'] ?? '[]';
        if (is_string($messages)) {
            $decoded = json_decode($messages, true);
            $messages = is_array($decoded) ? array_values($decoded) : [];
        }
        if (! is_array($messages)) {
            $messages = [];
        }

        return new self(
            id: (int) ($row['id'] ?? 0),
            uuid: (string) ($row['uuid'] ?? ''),
            userId: (int) ($row['user_id'] ?? 0),
            title: (string) ($row['title'] ?? ''),
            messages: array_values(array_filter(
                $messages,
                static fn ($m) => is_array($m),
            )),
            summary: (string) ($row['summary'] ?? ''),
            model: (string) ($row['model'] ?? ''),
            archived: ! empty($row['archived']),
            totalInputTokens: (int) ($row['total_input_tokens'] ?? 0),
            totalOutputTokens: (int) ($row['total_output_tokens'] ?? 0),
            createdAt: (string) ($row['created_at'] ?? ''),
            updatedAt: (string) ($row['updated_at'] ?? ''),
        );
    }

    /**
     * Wire shape returned to the front-end / kept compatible with the legacy
     * array API. Field names match the DB column names so existing
     * consumers (JS conversation list, FacetWP-style filters) keep working.
     *
     * @return array{
     *     id: int,
     *     uuid: string,
     *     user_id: int,
     *     title: string,
     *     messages: list<array<string, mixed>>,
     *     summary: string,
     *     model: string,
     *     archived: bool,
     *     total_input_tokens: int,
     *     total_output_tokens: int,
     *     created_at: string,
     *     updated_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'uuid' => $this->uuid,
            'user_id' => $this->userId,
            'title' => $this->title,
            'messages' => $this->messages,
            'summary' => $this->summary,
            'model' => $this->model,
            'archived' => $this->archived,
            'total_input_tokens' => $this->totalInputTokens,
            'total_output_tokens' => $this->totalOutputTokens,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }
}
