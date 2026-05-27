<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Plugin;

/**
 * Per-user daily token budget — a backstop against runaway cost (a stuck
 * agentic loop, a scheduled skill gone wrong, or plain over-use). The
 * per-request {@see RateLimiter} caps how often someone can ask; this caps
 * total spend across a day.
 *
 * Usage is accumulated per UTC day in user meta (more durable than a
 * transient, which can be evicted). It's checked before a request runs, using
 * the day's accumulated usage, and incremented after — so a single request may
 * overshoot slightly, but the next one is refused.
 *
 * Configure with the `gds-assistant/daily_token_budget` filter or the
 * `GDS_ASSISTANT_DAILY_TOKEN_BUDGET` env/constant. A budget of 0 disables it.
 */
class TokenBudget
{
    private const META_PREFIX = '_gds_assistant_tokens_';

    /** Default daily budget per user (input + output). 0 disables the cap. */
    private const DEFAULT_BUDGET = 10_000_000;

    public static function budget(): int
    {
        $env = Plugin::env('GDS_ASSISTANT_DAILY_TOKEN_BUDGET');
        $default = ($env !== null && $env !== '') ? (int) $env : self::DEFAULT_BUDGET;

        return (int) apply_filters('gds-assistant/daily_token_budget', $default);
    }

    /**
     * @return true|\WP_Error True if within budget, WP_Error (429) if exceeded.
     */
    public static function check(int $userId): true|\WP_Error
    {
        $budget = self::budget();
        if ($budget <= 0) {
            return true; // disabled
        }

        $used = self::usedToday($userId);
        if ($used >= $budget) {
            return new \WP_Error(
                'token_budget_exceeded',
                sprintf(
                    'Daily AI token budget reached (%s of %s tokens used today). Try again tomorrow, or ask an administrator to raise gds-assistant/daily_token_budget.',
                    number_format($used),
                    number_format($budget),
                ),
                ['status' => 429],
            );
        }

        return true;
    }

    /**
     * Add tokens to today's running total for a user.
     */
    public static function record(int $userId, int $tokens): void
    {
        if ($tokens <= 0 || self::budget() <= 0) {
            return;
        }

        $key = self::key();
        self::cleanupStale($userId, $key);
        $used = (int) get_user_meta($userId, $key, true);
        update_user_meta($userId, $key, $used + $tokens);
    }

    public static function usedToday(int $userId): int
    {
        return (int) get_user_meta($userId, self::key(), true);
    }

    private static function key(): string
    {
        return self::META_PREFIX.gmdate('Y-m-d');
    }

    /**
     * Drop counters from previous days so user meta doesn't accumulate.
     */
    private static function cleanupStale(int $userId, string $todayKey): void
    {
        global $wpdb;
        // phpcs:disable WordPress.DB.DirectDatabaseQuery
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$wpdb->usermeta}
             WHERE user_id = %d
             AND meta_key LIKE %s
             AND meta_key != %s",
            $userId,
            $wpdb->esc_like(self::META_PREFIX).'%',
            $todayKey,
        ));
    }
}
