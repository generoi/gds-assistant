<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Api\ChatEndpoint;
use GeneroWP\Assistant\Api\RateLimiter;
use GeneroWP\Assistant\Storage\ConversationStore;
use GeneroWP\Assistant\Tests\TestCase;
use WP_REST_Request;

class ChatEndpointTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        ConversationStore::createTables();
    }

    public function test_route_is_registered(): void
    {
        $routes = rest_get_server()->get_routes();
        $this->assertArrayHasKey('/gds-assistant/v1/chat', $routes);
    }

    public function test_requires_authentication(): void
    {
        wp_set_current_user(0);

        $request = new WP_REST_Request('POST', '/gds-assistant/v1/chat');
        $request->set_body_params([
            'messages' => [['role' => 'user', 'content' => 'Hello']],
        ]);
        $response = rest_do_request($request);

        $this->assertEquals(401, $response->get_status());
    }

    public function test_requires_edit_posts_capability(): void
    {
        $subscriber = self::factory()->user->create(['role' => 'subscriber']);
        wp_set_current_user($subscriber);

        $request = new WP_REST_Request('POST', '/gds-assistant/v1/chat');
        $request->set_body_params([
            'messages' => [['role' => 'user', 'content' => 'Hello']],
        ]);
        $response = rest_do_request($request);

        $this->assertEquals(403, $response->get_status());
    }

    public function test_custom_capability_filter(): void
    {
        $subscriber = self::factory()->user->create(['role' => 'subscriber']);
        wp_set_current_user($subscriber);

        // Allow subscribers via filter
        add_filter('gds-assistant/capability', fn () => 'read');

        $request = new WP_REST_Request('POST', '/gds-assistant/v1/chat');
        $request->set_body_params([
            'messages' => [['role' => 'user', 'content' => 'Hello']],
        ]);
        $response = rest_do_request($request);

        // Should pass permission check (may fail for other reasons like no provider)
        $this->assertNotEquals(401, $response->get_status());
        $this->assertNotEquals(403, $response->get_status());

        remove_all_filters('gds-assistant/capability');
    }

    public function test_requires_messages_param(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        $request = new WP_REST_Request('POST', '/gds-assistant/v1/chat');
        // No messages param
        $response = rest_do_request($request);

        $this->assertEquals(400, $response->get_status());
    }

    public function test_rate_limiting(): void
    {
        $editor = $this->createEditorUser();
        wp_set_current_user($editor);

        // Set a very low rate limit
        add_filter('gds-assistant/rate_limit', fn () => ['requests' => 2, 'window' => 300]);

        // First two requests should pass rate check
        $this->assertTrue(RateLimiter::check($editor));
        $this->assertTrue(RateLimiter::check($editor));

        // Third should fail
        $result = RateLimiter::check($editor);
        $this->assertWPError($result);
        $this->assertEquals('rate_limited', $result->get_error_code());

        // Clean up
        delete_transient("gds_assistant_rate_{$editor}");
        remove_all_filters('gds-assistant/rate_limit');
    }

    public function test_rate_limit_is_per_user(): void
    {
        $editor1 = $this->createEditorUser();
        $editor2 = $this->createEditorUser();

        add_filter('gds-assistant/rate_limit', fn () => ['requests' => 1, 'window' => 300]);

        // User 1 hits their limit
        $this->assertTrue(RateLimiter::check($editor1));
        $result = RateLimiter::check($editor1);
        $this->assertWPError($result);

        // User 2 should still be fine
        $this->assertTrue(RateLimiter::check($editor2));

        delete_transient("gds_assistant_rate_{$editor1}");
        delete_transient("gds_assistant_rate_{$editor2}");
        remove_all_filters('gds-assistant/rate_limit');
    }

    private function mergeRoles(array $messages): array
    {
        $m = new \ReflectionMethod(ChatEndpoint::class, 'mergeConsecutiveRoles');
        $m->setAccessible(true);

        return $m->invoke(null, $messages);
    }

    public function test_merge_consecutive_roles_collapses_same_role(): void
    {
        // An assistant turn followed by an out-of-band user note, then a real
        // user message — the two user messages must collapse into one so the
        // provider sees valid alternation.
        $merged = $this->mergeRoles([
            ['role' => 'assistant', 'content' => 'Deleted the page.'],
            ['role' => 'user', 'content' => '↩ Reverted: Restore the page'],
            ['role' => 'user', 'content' => 'thanks'],
        ]);

        $this->assertCount(2, $merged);
        $this->assertSame('assistant', $merged[0]['role']);
        $this->assertSame('user', $merged[1]['role']);
        // Both user texts survive as content blocks.
        $this->assertCount(2, $merged[1]['content']);
        $this->assertSame('↩ Reverted: Restore the page', $merged[1]['content'][0]['text']);
        $this->assertSame('thanks', $merged[1]['content'][1]['text']);
    }

    public function test_merge_consecutive_roles_leaves_alternating_intact(): void
    {
        $messages = [
            ['role' => 'user', 'content' => 'hi'],
            ['role' => 'assistant', 'content' => 'hello'],
            ['role' => 'user', 'content' => 'bye'],
        ];
        $this->assertSame($messages, $this->mergeRoles($messages));
    }
}
