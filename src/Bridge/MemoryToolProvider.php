<?php

namespace GeneroWP\Assistant\Bridge;

class MemoryToolProvider implements ToolProviderInterface
{
    private const PREFIX = 'assistant__memory-';

    public function getTools(): array
    {
        return [
            [
                'name' => 'assistant__memory-list',
                'description' => 'List all saved memory entries (persistent facts about this site learned from previous conversations).',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => (object) [],
                ],
            ],
            [
                'name' => 'assistant__memory-save',
                'description' => 'Save a useful fact about this site to memory. Will persist across all future conversations. Use when you discover something worth remembering (site structure, preferences, key IDs, common patterns, user preferences).',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'title' => ['type' => 'string', 'description' => 'Short title (e.g. "Default contact email", "Site languages")'],
                        'content' => ['type' => 'string', 'description' => 'The fact to remember (e.g. "Contact forms send to oskar@genero.fi", "Site has 3 languages: fi (default), en, sv")'],
                    ],
                    'required' => ['title', 'content'],
                ],
            ],
            [
                'name' => 'assistant__memory-forget',
                'description' => 'Delete a memory entry by ID (if it is outdated or incorrect).',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'integer', 'description' => 'Memory entry post ID to delete'],
                    ],
                    'required' => ['id'],
                ],
            ],
        ];
    }

    public function executeTool(string $name, array $input): mixed
    {
        $capability = apply_filters('gds-assistant/capability', 'edit_posts');
        if (! current_user_can($capability)) {
            return new \WP_Error('forbidden', 'Insufficient permissions');
        }

        return match ($name) {
            'assistant__memory-list' => $this->listMemories(),
            'assistant__memory-save' => $this->saveMemory($input),
            'assistant__memory-forget' => $this->forgetMemory($input),
            default => new \WP_Error('unknown_tool', "Unknown tool: {$name}"),
        };
    }

    public function handles(string $name): bool
    {
        return str_starts_with($name, self::PREFIX);
    }

    private function listMemories(): array
    {
        $posts = get_posts([
            'post_type' => 'assistant_memory',
            'post_status' => 'publish',
            'numberposts' => 100,
            'orderby' => 'date',
            'order' => 'DESC',
        ]);

        return array_map(fn ($p) => [
            'id' => $p->ID,
            'title' => $p->post_title,
            'content' => $p->post_content,
            'source' => get_post_meta($p->ID, '_memory_source', true) ?: 'manual',
            'date' => $p->post_date,
        ], $posts);
    }

    private function saveMemory(array $input): array|\WP_Error
    {
        $title = sanitize_text_field($input['title'] ?? '');
        $content = sanitize_textarea_field($input['content'] ?? '');
        if (! $title || ! $content) {
            return new \WP_Error('invalid_input', 'Title and content are required');
        }
        if (mb_strlen($title) > 200 || mb_strlen($content) > 5000) {
            return new \WP_Error('invalid_input', 'Title max 200 chars, content max 5000 chars');
        }

        $postId = wp_insert_post([
            'post_type' => 'assistant_memory',
            'post_title' => $title,
            'post_content' => $content,
            'post_status' => 'publish',
        ], true);

        if (is_wp_error($postId)) {
            return $postId;
        }

        update_post_meta($postId, '_memory_source', 'auto');

        return [
            'id' => $postId,
            'title' => $input['title'] ?? '',
            'message' => 'Memory saved. This will be available in all future conversations.',
        ];
    }

    private function forgetMemory(array $input): array|\WP_Error
    {
        $id = $input['id'] ?? 0;
        $post = get_post($id);

        if (! $post || $post->post_type !== 'assistant_memory') {
            return new \WP_Error('not_found', 'Memory entry not found');
        }

        wp_delete_post($id, true);

        return ['deleted' => true, 'id' => $id];
    }
}
