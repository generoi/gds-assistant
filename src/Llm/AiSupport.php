<?php

namespace GeneroWP\Assistant\Llm;

final class AiSupport
{
    public static function isEnabled(): bool
    {
        if (function_exists('wp_supports_ai')) {
            return (bool) wp_supports_ai();
        }

        return true;
    }

    public static function supportsCoreTextGeneration(): bool
    {
        if (! self::isEnabled() || ! function_exists('wp_ai_client_prompt')) {
            return false;
        }

        $builder = wp_ai_client_prompt('test');

        return is_object($builder)
            && method_exists($builder, 'is_supported_for_text_generation')
            && (bool) $builder->is_supported_for_text_generation();
    }

    public static function unavailableMessage(): string
    {
        return __('AI features are disabled for this WordPress site.', 'gds-assistant');
    }
}
