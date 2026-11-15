<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Tests\TestCase;
use WP_REST_Request;

class BlockMarkupEndpointTest extends TestCase
{
    private const MARKUP = "<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->";

    public function test_returns_raw_saved_markup_for_any_post_type(): void
    {
        wp_set_current_user($this->createEditorUser());
        $pageId = self::factory()->post->create(['post_type' => 'page', 'post_content' => self::MARKUP]);

        $response = rest_do_request(new WP_REST_Request('GET', "/gds-assistant/v1/block-markup/{$pageId}"));

        $this->assertEquals(200, $response->get_status());
        $this->assertSame(
            ['id' => $pageId, 'type' => 'page', 'content' => self::MARKUP],
            $response->get_data(),
        );
    }

    public function test_requires_permission_to_edit_the_post(): void
    {
        $postId = self::factory()->post->create([
            'post_content' => self::MARKUP,
            'post_author' => $this->createAdminUser(),
        ]);
        $contributor = self::factory()->user->create(['role' => 'contributor']);
        wp_set_current_user($contributor);

        $response = rest_do_request(new WP_REST_Request('GET', "/gds-assistant/v1/block-markup/{$postId}"));

        $this->assertEquals(403, $response->get_status());
    }
}
