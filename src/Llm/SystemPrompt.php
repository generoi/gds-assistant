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

        return apply_filters('gds-assistant/system_prompt', $prompt, [
            'site_name' => $siteName,
            'site_url' => $siteUrl,
            'post_types' => $postTypeList,
            'languages' => $languages,
        ]);
    }
}
