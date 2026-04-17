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

            $entry = [
                'name' => self::toToolName($name),
                'description' => $description,
                'input_schema' => $inputSchema,
            ];

            // Pass through `min_tier` so ToolRestrictor can gate tools that
            // need solid instruction-following. Not sent to the LLM — used
            // only by our filtering layer.
            if (! empty($annotations['min_tier'])) {
                $entry['min_tier'] = (string) $annotations['min_tier'];
            }

            $this->toolCache[] = $entry;
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

        // LLMs sometimes normalize tool names (hyphens → underscores) before
        // calling them — e.g. `gds__mail-send` becomes `gds__mail_send`. If
        // the exact match fails, try swapping underscores back to hyphens
        // in the ability-suffix part (after the namespace `/`).
        if (! $ability && str_contains($abilityName, '/')) {
            [$ns, $suffix] = explode('/', $abilityName, 2);
            $fallback = $ns.'/'.str_replace('_', '-', $suffix);
            if ($fallback !== $abilityName) {
                $ability = wp_get_ability($fallback);
                if ($ability) {
                    $abilityName = $fallback;
                }
            }
        }

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
