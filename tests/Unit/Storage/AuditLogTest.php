<?php

namespace GeneroWP\Assistant\Tests\Unit\Storage;

use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Tests\TestCase;

class AuditLogTest extends TestCase
{
    private AuditLog $log;

    private int $userId;

    protected function setUp(): void
    {
        parent::setUp();
        AuditLog::createTables();
        $this->log = new AuditLog;
        $this->userId = $this->createEditorUser();
    }

    public function test_log_creates_entry(): void
    {
        $this->log->log(
            'conv-uuid-123',
            $this->userId,
            'gds/posts-list',
            ['per_page' => 10],
            [['id' => 1, 'title' => 'Test']],
        );

        $entries = $this->log->getForConversation('conv-uuid-123');
        $this->assertCount(1, $entries);
        $this->assertEquals('gds/posts-list', $entries[0]['tool_name']);
        $this->assertEquals(0, $entries[0]['is_error']);
    }

    public function test_log_records_errors(): void
    {
        $this->log->log(
            'conv-uuid-123',
            $this->userId,
            'gds/posts-delete',
            ['id' => 999],
            new \WP_Error('not_found', 'Post not found'),
            isError: true,
            isDestructive: true,
        );

        $entries = $this->log->getForConversation('conv-uuid-123');
        $this->assertCount(1, $entries);
        $this->assertEquals(1, $entries[0]['is_error']);
        $this->assertEquals(1, $entries[0]['is_destructive']);
    }

    public function test_log_fires_action(): void
    {
        $fired = false;
        add_action('gds-assistant/tool_executed', function () use (&$fired) {
            $fired = true;
        });

        $this->log->log('conv-uuid', $this->userId, 'gds/test', [], ['ok']);

        $this->assertTrue($fired);
    }

    public function test_prune_removes_old_entries(): void
    {
        global $wpdb;

        $this->log->log('conv-uuid', $this->userId, 'gds/test', [], ['ok']);

        $wpdb->update(
            AuditLog::tableName(),
            ['created_at' => '2020-01-01 00:00:00'],
            ['conversation_uuid' => 'conv-uuid'],
        );

        $pruned = $this->log->prune(30);
        $this->assertEquals(1, $pruned);
    }
}
