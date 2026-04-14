<?php

namespace GeneroWP\Assistant\Llm;

class SystemPrompt
{
    private const CACHE_KEY = 'gds_assistant_system_prompt';

    private const CACHE_TTL = 5 * MINUTE_IN_SECONDS;

    public static function build(): string
    {
        $cacheKey = self::CACHE_KEY.'_'.get_current_blog_id();
        $cached = get_transient($cacheKey);
        if ($cached !== false) {
            return $cached;
        }

        $siteName = get_bloginfo('name');
        $siteUrl = home_url();
        $wpVersion = get_bloginfo('version');
        $locale = get_locale();

        $postTypes = get_post_types(['public' => true], 'objects');
        $postTypeList = implode(', ', array_map(
            fn ($pt) => $pt->labels->name." ({$pt->name})",
            $postTypes,
        ));

        $languages = 'n/a';
        if (function_exists('pll_languages_list')) {
            $languages = implode(', ', pll_languages_list(['fields' => 'name']));
        }

        $prompt = <<<PROMPT
        You are a WordPress content management assistant for "{$siteName}" ({$siteUrl}).
        WordPress {$wpVersion}, locale: {$locale}.

        Post types: {$postTypeList}
        Languages: {$languages}

        Guidelines:
        - Read the tool descriptions carefully — they explain the expected parameter formats
        - For destructive operations (delete, bulk update), confirm with the user first
        - When editing block content, read the current blocks first to understand the structure
        - Use _fields parameter on list queries to reduce response size
        - Provide clear summaries of what was changed after each operation
        - Be concise and helpful
        PROMPT;

        // Inject memory (persistent knowledge)
        $memory = self::getMemoryEntries();
        if ($memory) {
            $prompt .= "\n\n## Site knowledge (from memory)\n".$memory;
        }

        // Auto-memory instruction
        $autoMemory = get_option('gds_assistant_auto_memory', true);
        if ($autoMemory) {
            $prompt .= "\n\nYou can save important facts to memory using assistant__memory-save, but do so VERY sparingly — only for critical, permanent site facts that would be hard to rediscover (e.g. a non-obvious ID mapping, a custom convention, a user preference). Never save audit results, summaries, lists, or anything that can be re-queried. Max 1 sentence per entry.";
        }

        // Custom prompt additions from settings
        $customPrompt = trim(get_option('gds_assistant_custom_prompt', ''));
        if ($customPrompt) {
            $prompt .= "\n\n## Custom instructions\n".$customPrompt;
        }

        $prompt = apply_filters('gds-assistant/system_prompt', $prompt, [
            'site_name' => $siteName,
            'site_url' => $siteUrl,
            'post_types' => $postTypeList,
            'languages' => $languages,
        ]);

        set_transient($cacheKey, $prompt, self::CACHE_TTL);

        return $prompt;
    }

    /**
     * Bust the cached system prompt (called when settings or memory change).
     */
    public static function bustCache(): void
    {
        delete_transient(self::CACHE_KEY.'_'.get_current_blog_id());
    }

    /**
     * Get all memory entries formatted for the system prompt.
     */
    private static function getMemoryEntries(): string
    {
        $posts = get_posts([
            'post_type' => 'assistant_memory',
            'post_status' => 'publish',
            'numberposts' => 50,
            'orderby' => 'date',
            'order' => 'ASC',
        ]);

        if (empty($posts)) {
            return '';
        }

        $entries = array_map(
            fn ($p) => "- **{$p->post_title}**: {$p->post_content}",
            $posts,
        );

        return implode("\n", $entries);
    }
}
