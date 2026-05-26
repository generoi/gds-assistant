<?php

namespace GeneroWP\Assistant\Tests\Unit\Api;

use GeneroWP\Assistant\Api\UndoEndpoint;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Tests\TestCase;
use WP_REST_Request;

class UndoEndpointTest extends TestCase
{
    private UndoEndpoint $endpoint;

    private AuditLog $log;

    private int $userId;

    protected function setUp(): void
    {
        parent::setUp();
        AuditLog::createTables();
        $this->endpoint = new UndoEndpoint;
        $this->log = new AuditLog;
        $this->userId = $this->createAdminUser();
        wp_set_current_user($this->userId);
    }

    protected function tearDown(): void
    {
        remove_all_filters('gds-mcp/restore_snapshot');
        parent::tearDown();
    }

    private function logReversible(int $userId): int
    {
        $res = $this->log->log('conv', $userId, 'gds/content-update', ['id' => 1], ['ok' => true], false, true, [
            'kind' => 'restore-post',
            'data' => ['id' => 1],
            'label' => 'Revert "X"',
        ]);

        return (int) $res['id'];
    }

    private function request(int $id): WP_REST_Request
    {
        $req = new WP_REST_Request('POST', '/gds-assistant/v1/undo');
        $req->set_param('id', $id);

        return $req;
    }

    public function test_undo_applies_snapshot_and_returns_200(): void
    {
        $received = null;
        add_filter('gds-mcp/restore_snapshot', function ($default, $snapshot) use (&$received) {
            $received = $snapshot;

            return ['restored' => 'post', 'id' => 1];
        }, 10, 2);

        $id = $this->logReversible($this->userId);
        $response = $this->endpoint->handle($this->request($id));

        $this->assertSame(200, $response->get_status());
        $this->assertTrue($response->get_data()['undone']);
        $this->assertSame('restore-post', $received['kind'] ?? null);

        // Marked undone -> a second attempt fails.
        $second = $this->endpoint->handle($this->request($id));
        $this->assertSame(400, $second->get_status());
    }

    public function test_cannot_undo_another_users_action(): void
    {
        $other = $this->createEditorUser();
        $id = $this->logReversible($other);

        $response = $this->endpoint->handle($this->request($id));
        $this->assertSame(400, $response->get_status());
        $this->assertSame('not_found', $response->get_data()['code']);
    }

    public function test_unknown_id_returns_error(): void
    {
        $response = $this->endpoint->handle($this->request(999999));
        $this->assertSame(400, $response->get_status());
    }

    public function test_permission_requires_capability(): void
    {
        wp_set_current_user(0);
        $this->assertFalse($this->endpoint->checkPermission());

        wp_set_current_user($this->userId);
        $this->assertTrue($this->endpoint->checkPermission());
    }
}
