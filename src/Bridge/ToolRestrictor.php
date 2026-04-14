<?php

namespace GeneroWP\Assistant\Bridge;

/**
 * Filters available tools based on model capability tier.
 *
 * Tiers: read (safe only), standard (safe + moderate), full (all).
 * Risk levels: safe (read-only + reversible), moderate (non-reversible writes), dangerous (irreversible).
 */
class ToolRestrictor
{
    /**
     * Filter tools based on model tier.
     *
     * @param  array  $tools  Tool definitions from ToolRegistry
     * @param  string  $tier  Model tier: 'read', 'standard', or 'full'
     * @return array Filtered tools
     */
    public static function filter(array $tools, string $tier): array
    {
        if ($tier === 'full') {
            return $tools;
        }

        $allowedRisks = match ($tier) {
            'read' => ['safe'],
            'standard' => ['safe', 'moderate'],
            default => ['safe', 'moderate'],
        };

        return array_values(array_filter($tools, function (array $tool) use ($allowedRisks) {
            $risk = self::classifyRisk($tool);

            return in_array($risk, $allowedRisks, true);
        }));
    }

    /**
     * Classify a tool's risk level.
     *
     * @return string 'safe', 'moderate', or 'dangerous'
     */
    public static function classifyRisk(array $tool): string
    {
        $name = $tool['name'] ?? '';
        $desc = $tool['description'] ?? '';

        // Internal assistant tools (skills, memory) are always safe
        if (str_starts_with($name, 'assistant__')) {
            return 'safe';
        }

        // Determine risk from annotations first, then name patterns
        if (str_starts_with($desc, '[DESTRUCTIVE]')) {
            $risk = 'dangerous';
        } elseif (str_starts_with($desc, '[READ-ONLY]')) {
            $risk = 'safe';
        } else {
            $risk = self::classifyByName($name);
        }

        // Filter allows site owners to override any classification
        return apply_filters('gds-assistant/tool_risk_level', $risk, $tool);
    }

    /**
     * Classify risk by tool name patterns.
     * Content create/update are safe (revisions protect them).
     * Term/menu/form writes are moderate (no revisions).
     * Deletes of non-content are dangerous.
     */
    private static function classifyByName(string $name): string
    {
        // Read operations — safe
        if (preg_match('/-(list|read|get)$/', $name)) {
            return 'safe';
        }

        // Content writes — safe (revisions + trash exist)
        if (preg_match('/^gds__content-(create|update)$/', $name)) {
            return 'safe';
        }
        if (preg_match('/^gds__posts-duplicate$/', $name)) {
            return 'safe';
        }

        // Content delete — moderate (trash/soft-delete, recoverable)
        if (preg_match('/^gds__content-delete$/', $name)) {
            return 'moderate';
        }

        // Terms writes — moderate (no revisions)
        if (preg_match('/^gds__terms-(create|update|delete)$/', $name)) {
            return 'moderate';
        }

        // Terms delete specifically — dangerous (irreversible)
        if ($name === 'gds__terms-delete') {
            return 'dangerous';
        }

        // Menus, forms, translations — moderate
        if (preg_match('/^gds__(menus|forms|translations)-/', $name)) {
            return 'moderate';
        }

        // Cache clear — dangerous
        if ($name === 'gds__cache-clear') {
            return 'dangerous';
        }

        // Default: moderate (err on the side of caution for unknown tools)
        return 'moderate';
    }
}
