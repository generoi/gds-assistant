<?php

namespace GeneroWP\Assistant\Llm;

class SystemPrompt
{
    public static function build(): string
    {
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
            $prompt .= "\n\nIf you discover useful facts about this site (structure, preferences, key IDs, patterns), save them to memory using assistant__memory-save so future conversations have this context.";
        }

        // Custom prompt additions from settings
        $customPrompt = trim(get_option('gds_assistant_custom_prompt', ''));
        if ($customPrompt) {
            $prompt .= "\n\n## Custom instructions\n".$customPrompt;
        }

        return apply_filters('gds-assistant/system_prompt', $prompt, [
            'site_name' => $siteName,
            'site_url' => $siteUrl,
            'post_types' => $postTypeList,
            'languages' => $languages,
        ]);
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
