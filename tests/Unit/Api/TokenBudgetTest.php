<?php

namespace GeneroWP\Assistant\Tests\Unit\Api;

use GeneroWP\Assistant\Api\TokenBudget;
use GeneroWP\Assistant\Tests\TestCase;

class TokenBudgetTest extends TestCase
{
    private int $userId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->userId = $this->createEditorUser();
    }

    protected function tearDown(): void
    {
        remove_all_filters('gds-assistant/daily_token_budget');
        parent::tearDown();
    }

    public function test_within_budget_passes(): void
    {
        add_filter('gds-assistant/daily_token_budget', fn () => 1000);

        $this->assertTrue(TokenBudget::check($this->userId));
    }

    public function test_record_accumulates_and_exceeding_budget_errors(): void
    {
        add_filter('gds-assistant/daily_token_budget', fn () => 1000);

        TokenBudget::record($this->userId, 600);
        $this->assertSame(600, TokenBudget::usedToday($this->userId));
        $this->assertTrue(TokenBudget::check($this->userId), 'Still under budget at 600/1000.');

        TokenBudget::record($this->userId, 600); // now 1200 >= 1000
        $result = TokenBudget::check($this->userId);

        $this->assertWPError($result);
        $this->assertSame('token_budget_exceeded', $result->get_error_code());
    }

    public function test_budget_of_zero_disables_the_cap(): void
    {
        add_filter('gds-assistant/daily_token_budget', fn () => 0);

        TokenBudget::record($this->userId, 5_000_000);
        // record() is a no-op when disabled, and check() always passes.
        $this->assertSame(0, TokenBudget::usedToday($this->userId));
        $this->assertTrue(TokenBudget::check($this->userId));
    }

    public function test_budgets_are_per_user(): void
    {
        add_filter('gds-assistant/daily_token_budget', fn () => 1000);

        TokenBudget::record($this->userId, 1500); // over budget for user 1
        $other = $this->createEditorUser();

        $this->assertWPError(TokenBudget::check($this->userId));
        $this->assertTrue(TokenBudget::check($other), 'A different user has a separate budget.');
    }
}
