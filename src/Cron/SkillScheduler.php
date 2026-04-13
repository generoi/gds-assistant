<?php

namespace GeneroWP\Assistant\Cron;

use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Llm\MessageLoop;
use GeneroWP\Assistant\Llm\ProviderRegistry;
use GeneroWP\Assistant\Llm\SystemPrompt;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Storage\ConversationStore;

/**
 * Executes scheduled skills via WP-Cron.
 * Each due skill runs through MessageLoop and stores the result as a conversation.
 */
class SkillScheduler
{
    /** Map schedule names to seconds */
    private const INTERVALS = [
        'hourly' => HOUR_IN_SECONDS,
        'daily' => DAY_IN_SECONDS,
        'weekly' => WEEK_IN_SECONDS,
    ];

    public static function run(): void
    {
        $skills = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
            'numberposts' => 50,
            'meta_query' => [
                [
                    'key' => '_assistant_schedule',
                    'value' => array_keys(self::INTERVALS),
                    'compare' => 'IN',
                ],
            ],
        ]);

        foreach ($skills as $skill) {
            if (self::isDue($skill)) {
                self::executeSkill($skill);
            }
        }
    }

    private static function isDue(\WP_Post $skill): bool
    {
        $schedule = get_post_meta($skill->ID, '_assistant_schedule', true);
        $lastRun = (int) get_post_meta($skill->ID, '_assistant_last_run', true);
        $interval = self::INTERVALS[$schedule] ?? 0;

        if (! $interval) {
            return false;
        }

        return (time() - $lastRun) >= $interval;
    }

    private static function executeSkill(\WP_Post $skill): void
    {
        $modelKey = get_post_meta($skill->ID, '_assistant_model', true) ?: ProviderRegistry::getDefaultModelKey();
        if (! $modelKey) {
            return;
        }

        $resolved = ProviderRegistry::resolve($modelKey);
        if (! $resolved) {
            return;
        }

        $provider = $resolved['provider'];
        $modelId = $resolved['modelId'];

        // Create conversation for the result
        $store = new ConversationStore;
        $adminId = self::getAdminUserId();
        $conversationId = $store->create($adminId, $modelId);

        // Build tools
        $toolRegistry = new ToolRegistry;
        do_action('gds-assistant/register_tools', $toolRegistry);

        $auditLog = new AuditLog;
        $loop = new MessageLoop(
            $provider,
            $toolRegistry,
            $auditLog,
            $conversationId,
            $adminId,
        );

        $messages = [
            ['role' => 'user', 'content' => $skill->post_content],
        ];

        try {
            $systemPrompt = SystemPrompt::build();
            $updatedMessages = $loop->run(
                $messages,
                fn () => null, // No SSE streaming for cron
                $systemPrompt,
            );

            $title = '[Scheduled] '.$skill->post_title.' - '.wp_date('Y-m-d H:i');

            $store->update($conversationId, [
                'messages' => $updatedMessages,
                'title' => $title,
                'total_input_tokens' => $loop->getInputTokens(),
                'total_output_tokens' => $loop->getOutputTokens(),
            ]);
        } catch (\Throwable $e) {
            error_log("[gds-assistant] Scheduled skill '{$skill->post_title}' failed: ".$e->getMessage());

            $store->update($conversationId, [
                'title' => '[Scheduled][Failed] '.$skill->post_title.' - '.wp_date('Y-m-d H:i'),
                'messages' => [
                    ['role' => 'user', 'content' => $skill->post_content],
                    ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Error: '.$e->getMessage()]]],
                ],
            ]);
        }

        update_post_meta($skill->ID, '_assistant_last_run', time());
    }

    private static function getAdminUserId(): int
    {
        $admins = get_users(['role' => 'administrator', 'number' => 1, 'fields' => 'ID']);

        return ! empty($admins) ? (int) $admins[0] : 1;
    }
}
