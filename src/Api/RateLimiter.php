<?php

namespace GeneroWP\Assistant\Api;

class RateLimiter
{
    /**
     * Check if the user is within rate limits.
     *
     * @return true|\WP_Error True if allowed, WP_Error if rate limited.
     */
    public static function check(int $userId): true|\WP_Error
    {
        $config = apply_filters('gds-assistant/rate_limit', [
            'requests' => 20,
            'window' => 300, // 5 minutes
        ]);

        $key = "gds_assistant_rate_{$userId}";
        $current = get_transient($key);

        if ($current === false) {
            set_transient($key, 1, $config['window']);

            return true;
        }

        if ($current >= $config['requests']) {
            return new \WP_Error(
                'rate_limited',
                sprintf(
                    'Rate limit exceeded: %d requests per %d seconds. Please wait.',
                    $config['requests'],
                    $config['window'],
                ),
                ['status' => 429],
            );
        }

        // Increment counter (set_transient doesn't update expiry, use direct option update)
        set_transient($key, $current + 1, $config['window']);

        return true;
    }
}
