<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\UndoToolProvider;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Tests\TestCase;

class UndoToolProviderTest extends TestCase
{
    private UndoToolProvider $provider;

    private AuditLog $log;

    private int $userId;

    protected function setUp(): void
    {
        parent::setUp();
        AuditLog::createTables();
        $this->provider = new UndoToolProvider;
        $this->log = new AuditLog;
        $this->userId = $this->createAdminUser();
        wp_set_current_user($this->userId);
    }

    protected function tearDown(): void
    {
        remove_all_filters('gds-mcp/restore_snapshot');
        parent::tearDown();
    }

    private function logReversible(int $userId, array $undo): void
    {
        $this->log->log('conv-undo', $userId, 'gds/content-update', ['id' => 1], ['ok' => true], false, true, $undo);
    }

    public function test_undo_list_returns_reversible_entries(): void
    {
        $this->logReversible($this->userId, ['kind' => 'restore-post', 'data' => ['id' => 1], 'label' => 'Revert changes to "X"']);

        $list = $this->provider->executeTool('assistant__undo-list', []);

        $this->assertIsArray($list);
        $this->assertCount(1, $list);
        $this->assertSame('Revert changes to "X"', $list[0]['undo']);
    }

    public function test_undo_applies_snapshot_and_marks_entry_done(): void
    {
        // Stub gds-mcp's restore handler.
        $received = null;
        add_filter('gds-mcp/restore_snapshot', function ($default, $snapshot) use (&$received) {
            $received = $snapshot;

            return ['restored' => 'post', 'id' => 1];
        }, 10, 2);

        $this->logReversible($this->userId, ['kind' => 'restore-post', 'data' => ['id' => 1], 'label' => 'Revert "X"']);

        $result = $this->provider->executeTool('assistant__undo', []); // most recent
        $this->assertIsArray($result);
        $this->assertTrue($result['undone']);
        $this->assertSame('restore-post', $received['kind'] ?? null, 'The stored snapshot was passed to the restore filter.');

        // Marked undone -> no longer listed.
        $this->assertCount(0, $this->provider->executeTool('assistant__undo-list', []));
    }

    public function test_caveats_are_surfaced(): void
    {
        add_filter('gds-mcp/restore_snapshot', fn () => [
            'restored' => 'recreate-term',
            'caveats' => ['The term came back under a new id; check menu items.'],
        ], 10, 2);

        $this->logReversible($this->userId, ['kind' => 'recreate-term', 'data' => [], 'label' => 'Restore term']);

        $result = $this->provider->executeTool('assistant__undo', []);
        $this->assertNotEmpty($result['caveats']);
    }

    public function test_cannot_undo_another_users_action(): void
    {
        $other = $this->createEditorUser();
        $this->logReversible($other, ['kind' => 'restore-post', 'data' => ['id' => 9], 'label' => 'theirs']);

        // Find the id of the other user's entry.
        $row = $this->log->getReversible($other, 1)[0];

        $result = $this->provider->executeTool('assistant__undo', ['id' => (int) $row['id']]);
        $this->assertWPError($result);
        $this->assertSame('not_found', $result->get_error_code());
    }

    public function test_nothing_to_undo_errors(): void
    {
        $result = $this->provider->executeTool('assistant__undo', []);
        $this->assertWPError($result);
        $this->assertSame('nothing_to_undo', $result->get_error_code());
    }
}
