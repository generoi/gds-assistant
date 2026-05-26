<?php

namespace GeneroWP\Assistant\Tests\Unit\Cron;

use GeneroWP\Assistant\Cron\SkillScheduler;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class SkillSchedulerTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        // Register the assistant_skill post type if not already registered
        if (! post_type_exists('assistant_skill')) {
            register_post_type('assistant_skill', [
                'public' => false,
                'show_in_rest' => true,
            ]);
        }
    }

    public function test_skill_without_schedule_is_not_due(): void
    {
        $postId = self::factory()->post->create([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
            'post_title' => 'Test Skill',
        ]);

        // No _assistant_schedule meta set — should not be queried
        $skills = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
            'meta_query' => [
                [
                    'key' => '_assistant_schedule',
                    'value' => ['hourly', 'daily', 'weekly'],
                    'compare' => 'IN',
                ],
            ],
        ]);

        $this->assertEmpty($skills);

        wp_delete_post($postId, true);
    }

    public function test_skill_with_schedule_is_found(): void
    {
        $postId = self::factory()->post->create([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
            'post_title' => 'Scheduled Skill',
        ]);
        update_post_meta($postId, '_assistant_schedule', 'daily');

        $skills = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
            'numberposts' => 50,
            'meta_query' => [
                [
                    'key' => '_assistant_schedule',
                    'value' => ['hourly', 'daily', 'weekly'],
                    'compare' => 'IN',
                ],
            ],
        ]);

        $this->assertCount(1, $skills);
        $this->assertEquals('Scheduled Skill', $skills[0]->post_title);

        wp_delete_post($postId, true);
    }

    public function test_last_run_meta_is_stored(): void
    {
        $postId = self::factory()->post->create([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
        ]);

        $now = time();
        update_post_meta($postId, '_assistant_last_run', $now);

        $lastRun = (int) get_post_meta($postId, '_assistant_last_run', true);
        $this->assertSame($now, $lastRun);

        wp_delete_post($postId, true);
    }

    public function test_schedule_meta_values(): void
    {
        $postId = self::factory()->post->create([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
        ]);

        foreach (['hourly', 'daily', 'weekly'] as $schedule) {
            update_post_meta($postId, '_assistant_schedule', $schedule);
            $this->assertSame($schedule, get_post_meta($postId, '_assistant_schedule', true));
        }

        // Empty string clears schedule
        update_post_meta($postId, '_assistant_schedule', '');
        $this->assertSame('', get_post_meta($postId, '_assistant_schedule', true));

        wp_delete_post($postId, true);
    }

    public function test_pending_approval_tools_detects_unexecuted_gated_actions(): void
    {
        $method = new ReflectionMethod(SkillScheduler::class, 'pendingApprovalTools');
        $method->setAccessible(true);

        $messages = [
            ['role' => 'user', 'content' => 'do the thing'],
            ['role' => 'assistant', 'content' => [
                ['type' => 'tool_use', 'id' => 't1', 'name' => 'gds__forms-update', 'input' => []],
            ]],
            ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 't1', 'content' => json_encode([
                    'status' => 'pending_approval',
                    'tool_name' => 'gds/forms-update',
                ])],
            ]],
        ];

        $pending = $method->invoke(null, $messages);
        $this->assertSame(['gds/forms-update'], $pending);
    }

    public function test_pending_approval_tools_empty_when_all_executed(): void
    {
        $method = new ReflectionMethod(SkillScheduler::class, 'pendingApprovalTools');
        $method->setAccessible(true);

        $messages = [
            ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 't1', 'content' => json_encode(['ok' => true])],
            ]],
        ];

        $this->assertSame([], $method->invoke(null, $messages));
    }
}
