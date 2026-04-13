<?php

namespace GeneroWP\Assistant\Tests\Unit\Storage;

use GeneroWP\Assistant\Storage\ConversationStore;
use GeneroWP\Assistant\Tests\TestCase;

class ConversationStoreTest extends TestCase
{
    private ConversationStore $store;

    private int $userId;

    protected function setUp(): void
    {
        parent::setUp();
        ConversationStore::createTables();
        $this->store = new ConversationStore;
        $this->userId = $this->createEditorUser();
    }

    public function test_create_returns_uuid(): void
    {
        $uuid = $this->store->create($this->userId, 'claude-sonnet-4-20250514');

        $this->assertMatchesRegularExpression('/^[a-f0-9-]{36}$/', $uuid);
    }

    public function test_get_returns_conversation(): void
    {
        $uuid = $this->store->create($this->userId, 'claude-sonnet-4-20250514');
        $conversation = $this->store->get($uuid);

        $this->assertNotNull($conversation);
        $this->assertEquals($uuid, $conversation['uuid']);
        $this->assertEquals($this->userId, $conversation['user_id']);
        $this->assertEquals([], $conversation['messages']);
    }

    public function test_get_returns_null_for_unknown_uuid(): void
    {
        $conversation = $this->store->get('nonexistent-uuid');

        $this->assertNull($conversation);
    }

    public function test_update_persists_messages(): void
    {
        $uuid = $this->store->create($this->userId);
        $messages = [
            ['role' => 'user', 'content' => 'Hello'],
            ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Hi!']]],
        ];

        $this->store->update($uuid, [
            'messages' => $messages,
            'title' => 'Hello conversation',
        ]);

        $conversation = $this->store->get($uuid);
        $this->assertEquals('Hello conversation', $conversation['title']);
        $this->assertCount(2, $conversation['messages']);
    }

    public function test_list_for_user(): void
    {
        $this->store->create($this->userId, 'model-a');
        $this->store->create($this->userId, 'model-b');

        // Different user
        $otherUserId = $this->createEditorUser();
        $this->store->create($otherUserId, 'model-c');

        $list = $this->store->listForUser($this->userId);

        $this->assertCount(2, $list);
    }

    public function test_delete(): void
    {
        $uuid = $this->store->create($this->userId);

        $deleted = $this->store->delete($uuid, $this->userId);
        $this->assertTrue($deleted);

        $conversation = $this->store->get($uuid);
        $this->assertNull($conversation);
    }

    public function test_delete_requires_correct_user(): void
    {
        $uuid = $this->store->create($this->userId);
        $otherUserId = $this->createEditorUser();

        $deleted = $this->store->delete($uuid, $otherUserId);
        $this->assertFalse($deleted);

        // Still exists
        $this->assertNotNull($this->store->get($uuid));
    }

    public function test_prune_removes_old_conversations(): void
    {
        global $wpdb;

        $uuid = $this->store->create($this->userId);

        // Backdate the conversation
        $wpdb->update(
            ConversationStore::tableName(),
            ['updated_at' => '2020-01-01 00:00:00'],
            ['uuid' => $uuid],
        );

        $pruned = $this->store->prune(30);
        $this->assertEquals(1, $pruned);
        $this->assertNull($this->store->get($uuid));
    }
}
