<?php

namespace GeneroWP\Assistant\Bridge;

class SkillsToolProvider implements ToolProviderInterface
{
    private const PREFIX = 'assistant__skills-';

    public function getTools(): array
    {
        return [
            [
                'name' => 'assistant__skills-list',
                'description' => 'List all available AI assistant skills (reusable prompt templates).',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => (object) [],
                ],
            ],
            [
                'name' => 'assistant__skills-create',
                'description' => 'Create a new AI assistant skill (reusable prompt template). The skill becomes available to all users via /slug in the chat.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'title' => ['type' => 'string', 'description' => 'Skill name (e.g. "Translate Product Page")'],
                        'slug' => ['type' => 'string', 'description' => 'Short slash-command slug (e.g. "translate-product")'],
                        'description' => ['type' => 'string', 'description' => 'Brief description of what the skill does'],
                        'prompt' => ['type' => 'string', 'description' => 'The full prompt template. Can include {{placeholders}} that the user fills in.'],
                        'model' => ['type' => 'string', 'description' => 'Preferred model key (e.g. "gemini:gemini-flash", "anthropic:sonnet"). Auto-switches when skill is invoked. Leave empty for user\'s current selection.'],
                    ],
                    'required' => ['title', 'prompt'],
                ],
            ],
            [
                'name' => 'assistant__skills-update',
                'description' => 'Update an existing AI assistant skill by ID.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'integer', 'description' => 'Skill post ID'],
                        'title' => ['type' => 'string'],
                        'slug' => ['type' => 'string'],
                        'description' => ['type' => 'string'],
                        'prompt' => ['type' => 'string'],
                        'model' => ['type' => 'string', 'description' => 'Preferred model key'],
                    ],
                    'required' => ['id'],
                ],
            ],
        ];
    }

    public function executeTool(string $name, array $input): mixed
    {
        return match ($name) {
            'assistant__skills-list' => $this->listSkills(),
            'assistant__skills-create' => $this->createSkill($input),
            'assistant__skills-update' => $this->updateSkill($input),
            default => new \WP_Error('unknown_skill_tool', "Unknown tool: {$name}"),
        };
    }

    public function handles(string $name): bool
    {
        return str_starts_with($name, self::PREFIX);
    }

    private function listSkills(): array
    {
        $posts = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'any',
            'numberposts' => 100,
            'orderby' => 'title',
            'order' => 'ASC',
        ]);

        return array_map(fn ($post) => [
            'id' => $post->ID,
            'slug' => $post->post_name,
            'title' => $post->post_title,
            'description' => $post->post_excerpt,
            'prompt' => $post->post_content,
            'status' => $post->post_status,
        ], $posts);
    }

    private function createSkill(array $input): array|\WP_Error
    {
        $postId = wp_insert_post([
            'post_type' => 'assistant_skill',
            'post_title' => $input['title'] ?? '',
            'post_name' => $input['slug'] ?? '',
            'post_content' => $input['prompt'] ?? '',
            'post_excerpt' => $input['description'] ?? '',
            'post_status' => 'publish',
        ], true);

        if (is_wp_error($postId)) {
            return $postId;
        }

        if (! empty($input['model'])) {
            update_post_meta($postId, '_assistant_model', sanitize_text_field($input['model']));
        }

        $post = get_post($postId);

        return [
            'id' => $post->ID,
            'slug' => $post->post_name,
            'title' => $post->post_title,
            'description' => $post->post_excerpt,
            'model' => get_post_meta($postId, '_assistant_model', true) ?: '',
            'message' => "Skill created. Users can invoke it with /{$post->post_name} in the chat.",
        ];
    }

    private function updateSkill(array $input): array|\WP_Error
    {
        $id = $input['id'] ?? 0;
        $post = get_post($id);

        if (! $post || $post->post_type !== 'assistant_skill') {
            return new \WP_Error('not_found', 'Skill not found');
        }

        $update = ['ID' => $id];
        if (isset($input['title'])) {
            $update['post_title'] = $input['title'];
        }
        if (isset($input['slug'])) {
            $update['post_name'] = $input['slug'];
        }
        if (isset($input['prompt'])) {
            $update['post_content'] = $input['prompt'];
        }
        if (isset($input['description'])) {
            $update['post_excerpt'] = $input['description'];
        }

        if (isset($input['model'])) {
            update_post_meta($id, '_assistant_model', sanitize_text_field($input['model']));
        }

        $result = wp_update_post($update, true);
        if (is_wp_error($result)) {
            return $result;
        }

        $post = get_post($id);

        return [
            'id' => $post->ID,
            'slug' => $post->post_name,
            'title' => $post->post_title,
            'description' => $post->post_excerpt,
            'message' => 'Skill updated.',
        ];
    }
}
