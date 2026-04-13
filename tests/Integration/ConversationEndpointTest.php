<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Storage\ConversationStore;
use GeneroWP\Assistant\Tests\TestCase;
use WP_REST_Request;

class ConversationEndpointTest extends TestCase
{
    private ConversationStore $store;

    protected function setUp(): void
    {
        parent::setUp();
        ConversationStore::createTables();
        $this->store = new ConversationStore;
    }

    public function test_list_requires_authentication(): void
    {
        wp_set_current_user(0);

        $request = new WP_REST_Request('GET', '/gds-assistant/v1/conversations');
        $response = rest_do_request($request);

        $this->assertEquals(401, $response->get_status());
    }

    public function test_list_requires_edit_posts_capability(): void
    {
        $subscriber = self::factory()->user->create(['role' => 'subscriber']);
        wp_set_current_user($subscriber);

        $request = new WP_REST_Request('GET', '/gds-assistant/v1/conversations');
        $response = rest_do_request($request);

        $this->assertEquals(403, $response->get_status());
    }

    public function test_list_returns_own_conversations(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $uuid1 = $this->store->create($editor, 'anthropic:sonnet');
        $uuid2 = $this->store->create($editor, 'gemini:flash');

        // Another user's conversation should not appear
        $otherEditor = $this->createEditorUser();
        $this->store->create($otherEditor, 'openai:gpt-4o');

        $request = new WP_REST_Request('GET', '/gds-assistant/v1/conversations');
        $response = rest_do_request($request);

        $this->assertEquals(200, $response->get_status());
        $data = $response->get_data();
        $this->assertCount(2, $data);

        $uuids = array_column($data, 'uuid');
        $this->assertContains($uuid1, $uuids);
        $this->assertContains($uuid2, $uuids);
    }

    public function test_list_excludes_archived(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $uuid1 = $this->store->create($editor, 'anthropic:sonnet');
        $uuid2 = $this->store->create($editor, 'gemini:flash');
        $this->store->update($uuid2, ['archived' => 1]);

        $request = new WP_REST_Request('GET', '/gds-assistant/v1/conversations');
        $response = rest_do_request($request);

        $data = $response->get_data();
        $this->assertCount(1, $data);
        $this->assertEquals($uuid1, $data[0]['uuid']);
    }

    public function test_get_returns_own_conversation(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $uuid = $this->store->create($editor, 'anthropic:sonnet');
        $this->store->update($uuid, [
            'messages' => [['role' => 'user', 'content' => 'Hello']],
            'title' => 'Test chat',
        ]);

        $request = new WP_REST_Request('GET', "/gds-assistant/v1/conversations/{$uuid}");
        $response = rest_do_request($request);

        $this->assertEquals(200, $response->get_status());
        $data = $response->get_data();
        $this->assertEquals($uuid, $data['uuid']);
        $this->assertEquals('Test chat', $data['title']);
        $this->assertCount(1, $data['messages']);
    }

    public function test_get_returns_403_for_other_users_conversation(): void
    {
        $editor1 = $this->createEditorUser();
        $editor2 = $this->createEditorUser();

        $uuid = $this->store->create($editor1, 'anthropic:sonnet');

        wp_set_current_user($editor2);

        $request = new WP_REST_Request('GET', "/gds-assistant/v1/conversations/{$uuid}");
        $response = rest_do_request($request);

        $this->assertEquals(403, $response->get_status());
    }

    public function test_get_returns_404_for_nonexistent(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $request = new WP_REST_Request('GET', '/gds-assistant/v1/conversations/00000000-0000-0000-0000-000000000000');
        $response = rest_do_request($request);

        $this->assertEquals(404, $response->get_status());
    }

    public function test_update_archives_conversation(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $uuid = $this->store->create($editor, 'anthropic:sonnet');

        $request = new WP_REST_Request('POST', "/gds-assistant/v1/conversations/{$uuid}");
        $request->set_body_params(['archived' => true]);
        $response = rest_do_request($request);

        $this->assertEquals(200, $response->get_status());
        $this->assertTrue($response->get_data()['updated']);

        // Verify it's archived
        $conv = $this->store->get($uuid);
        $this->assertEquals(1, $conv['archived']);
    }

    public function test_update_returns_403_for_other_user(): void
    {
        $editor1 = $this->createEditorUser();
        $editor2 = $this->createEditorUser();

        $uuid = $this->store->create($editor1, 'anthropic:sonnet');

        wp_set_current_user($editor2);

        $request = new WP_REST_Request('POST', "/gds-assistant/v1/conversations/{$uuid}");
        $request->set_body_params(['archived' => true]);
        $response = rest_do_request($request);

        $this->assertEquals(403, $response->get_status());
    }

    public function test_delete_soft_deletes_by_archiving(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $uuid = $this->store->create($editor, 'anthropic:sonnet');

        $request = new WP_REST_Request('DELETE', "/gds-assistant/v1/conversations/{$uuid}");
        $response = rest_do_request($request);

        $this->assertEquals(200, $response->get_status());
        $this->assertTrue($response->get_data()['archived']);

        // Conversation still exists but is archived
        $conv = $this->store->get($uuid);
        $this->assertNotNull($conv);
        $this->assertEquals(1, $conv['archived']);
    }

    public function test_delete_returns_403_for_other_user(): void
    {
        $editor1 = $this->createEditorUser();
        $editor2 = $this->createEditorUser();

        $uuid = $this->store->create($editor1, 'anthropic:sonnet');

        wp_set_current_user($editor2);

        $request = new WP_REST_Request('DELETE', "/gds-assistant/v1/conversations/{$uuid}");
        $response = rest_do_request($request);

        $this->assertEquals(403, $response->get_status());

        // Conversation should NOT be archived
        $conv = $this->store->get($uuid);
        $this->assertEquals(0, $conv['archived']);
    }
}
