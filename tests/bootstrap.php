<?php

require_once dirname(__DIR__).'/vendor/autoload.php';

// Polyfill Acorn's env() for test environments where Laravel isn't loaded
if (! function_exists('env')) {
    function env(string $key, $default = null)
    {
        $value = getenv($key);

        return $value !== false ? $value : $default;
    }
}

require_once getenv('WP_PHPUNIT__DIR').'/includes/functions.php';

tests_add_filter('muplugins_loaded', function () {
    // Load gds-mcp if available (provides WP Abilities)
    $mcpPlugin = dirname(__DIR__, 2).'/gds-mcp/gds-mcp.php';
    if (file_exists($mcpPlugin) && file_exists(dirname($mcpPlugin).'/vendor/autoload.php')) {
        require_once $mcpPlugin;
    }

    // Load gds-assistant
    require_once dirname(__DIR__).'/gds-assistant.php';
});

require getenv('WP_PHPUNIT__DIR').'/includes/bootstrap.php';

// Trigger abilities registration if available
if (function_exists('wp_register_ability') && ! did_action('wp_abilities_api_init')) {
    do_action('wp_abilities_api_categories_init');
    do_action('wp_abilities_api_init');
}
