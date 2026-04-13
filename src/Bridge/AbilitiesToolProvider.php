<?php

namespace GeneroWP\Assistant\Bridge;

use WP_Ability;

class AbilitiesToolProvider implements ToolProviderInterface
{
    /** Tool name separator (replaces / which is invalid in LLM tool names) */
    private const SEPARATOR = '__';

    /** @var array<string, array> Cached tool definitions */
    private ?array $toolCache = null;

    public function getTools(): array
    {
        if ($this->toolCache !== null) {
            return $this->toolCache;
        }

        $this->toolCache = [];

        if (! function_exists('wp_get_abilities')) {
            return $this->toolCache;
        }

        $abilities = wp_get_abilities();

        foreach ($abilities as $ability) {
            /** @var WP_Ability $ability */
            $name = $ability->get_name();

            // Only include gds/* abilities (our MCP tools)
            if (! str_starts_with($name, 'gds/')) {
                continue;
            }

            // Skip REST-delegated CRUD for non-core post types to keep token count manageable.
            // The help tool can still discover everything.
            $meta = $ability->get_meta();
            if ($this->shouldSkip($name, $meta)) {
                continue;
            }

            $meta = $ability->get_meta();
            $annotations = $meta['annotations'] ?? [];

            // Build description with annotations
            $description = $ability->get_description();
            if (! empty($annotations['destructive'])) {
                $description = '[DESTRUCTIVE] '.$description;
            } elseif (! empty($annotations['readonly'])) {
                $description = '[READ-ONLY] '.$description;
            }

            $inputSchema = $ability->get_input_schema();

            // Ensure input_schema has type: object for Claude
            if (empty($inputSchema) || ! isset($inputSchema['type'])) {
                $inputSchema = [
                    'type' => 'object',
                    'properties' => (object) [],
                ];
            }

            // Anthropic API requires properties to be a JSON object ({}), not array ([]).
            // WordPress stores empty properties as [] (PHP array) which json_encode
            // serializes to []. Cast to object so it becomes {}.
            if (isset($inputSchema['properties']) && $inputSchema['properties'] === []) {
                $inputSchema['properties'] = (object) [];
            }

            $this->toolCache[] = [
                'name' => self::toToolName($name),
                'description' => $description,
                'input_schema' => $inputSchema,
            ];
        }

        return $this->toolCache;
    }

    public function executeTool(string $name, array $input): mixed
    {
        $abilityName = self::toAbilityName($name);

        if (! function_exists('wp_get_ability')) {
            return new \WP_Error('abilities_unavailable', 'WordPress Abilities API not available');
        }

        $ability = wp_get_ability($abilityName);
        if (! $ability) {
            return new \WP_Error('ability_not_found', "Ability not found: {$abilityName}");
        }

        try {
            $result = $ability->execute(! empty($input) ? $input : null);
        } catch (\Throwable $e) {
            error_log("[gds-assistant] Tool execution error ({$abilityName}): {$e->getMessage()} in {$e->getFile()}:{$e->getLine()}");

            return new \WP_Error('tool_execution_error', $e->getMessage());
        }

        if (is_wp_error($result)) {
            return $result;
        }

        // Deep-convert stdClass objects to arrays for reliable JSON serialization
        return json_decode(json_encode($result), true);
    }

    public function handles(string $name): bool
    {
        return str_starts_with($name, 'gds'.self::SEPARATOR);
    }

    /**
     * Skip abilities that would bloat the tool list beyond the token limit.
     *
     * With 149 tools + schemas, context easily exceeds 200K tokens.
     * We keep a curated set and let Claude discover more via gds/help.
     */
    private function shouldSkip(string $name, array $meta): bool
    {
        // Allowed prefixes — core CRUD + all custom/integration abilities
        static $allowedPrefixes = [
            'gds/help',
            'gds/posts-', 'gds/pages-', 'gds/media-',
            'gds/categories-', 'gds/tags-',
            // Custom abilities (non-CRUD)
            'gds/posts-duplicate', 'gds/posts-bulk-update',
            'gds/blocks-get', 'gds/blocks-patch', 'gds/block-types-',
            'gds/revisions-',
            'gds/site-map', 'gds/design-', 'gds/acf-',
            // Integrations
            'gds/languages-', 'gds/translations-', 'gds/strings-',
            'gds/forms-', 'gds/cache-',
            // Product CRUD (core CPT for this site)
            'gds/product-list', 'gds/product-read', 'gds/product-create', 'gds/product-update',
        ];

        foreach ($allowedPrefixes as $prefix) {
            if (str_starts_with($name, $prefix) || $name === $prefix) {
                return false;
            }
        }

        return true;
    }

    /**
     * Convert ability name (gds/posts-list) to LLM tool name (gds__posts-list).
     */
    public static function toToolName(string $abilityName): string
    {
        return str_replace('/', self::SEPARATOR, $abilityName);
    }

    /**
     * Convert LLM tool name (gds__posts-list) to ability name (gds/posts-list).
     */
    public static function toAbilityName(string $toolName): string
    {
        // Only replace the first occurrence (namespace separator)
        return preg_replace('/'.preg_quote(self::SEPARATOR, '/').'/', '/', $toolName, 1);
    }
}
