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

        // Scheduled skills run unattended with the author's identity. Only
        // administrators may schedule (enforced on the _assistant_schedule
        // meta auth_callback), so a non-admin author here means a stale or
        // tampered schedule — skip it rather than run with no cap enforcement.
        $authorId = (int) $skill->post_author;
        if (! $authorId || ! user_can($authorId, 'manage_options')) {
            error_log("[gds-assistant] Skipping scheduled skill '{$skill->post_title}': author #{$authorId} is not an administrator (scheduling requires manage_options).");
            update_post_meta($skill->ID, '_assistant_last_run', time());

            return;
        }

        // Create conversation for the result
        $store = new ConversationStore;
        $conversationId = $store->create($authorId, $modelId);

        // Execute as the author so ability capability checks resolve against a
        // real user — WP-Cron has no current user otherwise, which (combined
        // with the abilities' permission callbacks) decides what may run.
        $previousUser = get_current_user_id();
        wp_set_current_user($authorId);

        // Build tools
        $toolRegistry = new ToolRegistry;
        do_action('gds-assistant/register_tools', $toolRegistry);

        $auditLog = new AuditLog;
        $loop = new MessageLoop(
            $provider,
            $toolRegistry,
            $auditLog,
            $conversationId,
            $authorId,
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

            // A scheduled run has no human to approve gated actions, so the
            // loop leaves them as pending_approval stubs. Surface that instead
            // of letting the skill silently appear to "do nothing".
            $pending = self::pendingApprovalTools($updatedMessages);
            if ($pending) {
                $updatedMessages[] = ['role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Note: this scheduled run requested actions that require human approval and were NOT executed: '.implode(', ', $pending).'. Open this conversation and approve them, or run the skill interactively.']]];
            }

            $prefix = $pending ? '[Scheduled][Needs approval] ' : '[Scheduled] ';
            $title = $prefix.$skill->post_title.' - '.wp_date('Y-m-d H:i');

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
        } finally {
            wp_set_current_user($previousUser);
        }

        update_post_meta($skill->ID, '_assistant_last_run', time());
    }

    /**
     * Collect the (deduplicated) names of tools the loop left awaiting human
     * approval — i.e. tool_result blocks with a pending_approval status.
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @return string[]
     */
    private static function pendingApprovalTools(array $messages): array
    {
        $names = [];
        foreach ($messages as $msg) {
            if (($msg['role'] ?? '') !== 'user' || ! is_array($msg['content'] ?? null)) {
                continue;
            }
            foreach ($msg['content'] as $block) {
                if (! is_array($block) || ($block['type'] ?? '') !== 'tool_result') {
                    continue;
                }
                $content = is_string($block['content'] ?? null) ? $block['content'] : '';
                $decoded = json_decode($content, true);
                if (is_array($decoded) && ($decoded['status'] ?? '') === 'pending_approval') {
                    $names[] = $decoded['tool_name'] ?? 'unknown';
                }
            }
        }

        return array_values(array_unique($names));
    }
}
