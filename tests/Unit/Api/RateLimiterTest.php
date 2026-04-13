<?php

namespace GeneroWP\Assistant\Tests\Unit\Api;

use GeneroWP\Assistant\Api\RateLimiter;
use GeneroWP\Assistant\Tests\TestCase;

class RateLimiterTest extends TestCase
{
    private int $userId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->userId = $this->createEditorUser();
    }

    public function test_first_request_passes(): void
    {
        $result = RateLimiter::check($this->userId);

        $this->assertTrue($result);
    }

    public function test_exceeding_limit_returns_error(): void
    {
        // Set a very low limit for testing
        add_filter('gds-assistant/rate_limit', function () {
            return ['requests' => 2, 'window' => 60];
        });

        RateLimiter::check($this->userId);
        RateLimiter::check($this->userId);
        $result = RateLimiter::check($this->userId);

        $this->assertWPError($result);
        $this->assertEquals('rate_limited', $result->get_error_code());

        remove_all_filters('gds-assistant/rate_limit');
    }

    public function test_different_users_have_separate_limits(): void
    {
        add_filter('gds-assistant/rate_limit', function () {
            return ['requests' => 1, 'window' => 60];
        });

        $user2 = $this->createEditorUser();

        RateLimiter::check($this->userId);
        $result = RateLimiter::check($user2);

        // User2 should still pass
        $this->assertTrue($result);

        remove_all_filters('gds-assistant/rate_limit');
    }
}
