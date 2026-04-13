<?php

namespace GeneroWP\Assistant;

class Plugin
{
    protected static $instance;

    public readonly string $file;

    public readonly string $path;

    public readonly string $url;

    public static function getInstance(): static
    {
        if (! isset(self::$instance)) {
            self::$instance = new static;
        }

        return self::$instance;
    }

    public function __construct()
    {
        $this->file = realpath(__DIR__.'/../gds-assistant.php');
        $this->path = untrailingslashit(plugin_dir_path($this->file));
        $this->url = untrailingslashit(plugin_dir_url($this->file));

        add_action('init', [$this, 'registerPostTypes']);
        add_action('admin_enqueue_scripts', [$this, 'enqueueAdminAssets']);
        add_action('rest_api_init', [$this, 'registerRestRoutes']);
        add_action('gds-assistant/register_tools', [$this, 'registerToolProviders']);
        add_action('gds_assistant_cleanup', [$this, 'runCleanup']);

        // Settings page
        new Admin\SettingsPage($this);

        register_activation_hook($this->file, [$this, 'activate']);
        register_deactivation_hook($this->file, [$this, 'deactivate']);
    }

    public function enqueueAdminAssets(): void
    {
        $capability = apply_filters('gds-assistant/capability', 'edit_posts');
        if (! current_user_can($capability)) {
            return;
        }

        // Don't load widget if no AI provider is configured
        if (! Llm\ProviderRegistry::hasAnyProvider()) {
            return;
        }

        $assetFile = $this->path.'/build/admin-chat.asset.php';
        if (! file_exists($assetFile)) {
            return;
        }

        $asset = require $assetFile;

        wp_enqueue_script(
            'gds-assistant',
            $this->url.'/build/admin-chat.js',
            $asset['dependencies'],
            $asset['version'],
            true,
        );

        wp_enqueue_style(
            'gds-assistant',
            $this->url.'/build/admin-chat.css',
            [],
            $asset['version'],
        );

        $modelConfig = Llm\ProviderRegistry::getModelsForFrontend();
        $defaultMaxTokens = (int) (env('GDS_ASSISTANT_MAX_TOKENS') ?: 4096);

        wp_localize_script('gds-assistant', 'gdsAssistant', [
            'restUrl' => rest_url('gds-assistant/v1/'),
            'restBase' => rest_url('wp/v2/'),
            'nonce' => wp_create_nonce('wp_rest'),
            'models' => $modelConfig,
            'modelPricing' => $modelConfig['pricing'] ?? [],
            'defaultMaxTokens' => $defaultMaxTokens,
            'skills' => $this->getPublishedSkills(),
        ]);
    }

    public function registerRestRoutes(): void
    {
        $chatEndpoint = new Api\ChatEndpoint($this);
        $chatEndpoint->register();

        $conversationEndpoint = new Api\ConversationEndpoint($this);
        $conversationEndpoint->register();
    }

    public function registerPostTypes(): void
    {
        register_post_type('assistant_skill', [
            'labels' => [
                'name' => 'Skills',
                'singular_name' => 'Skill',
                'add_new_item' => 'Add New Skill',
                'edit_item' => 'Edit Skill',
                'menu_name' => 'AI Skills',
            ],
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => false, // Managed via AI Assistant > Skills DataView
            'show_in_rest' => true,
            'rest_base' => 'assistant-skills',
            'supports' => ['title', 'editor', 'excerpt', 'revisions', 'author'],
            'capability_type' => 'post',
            'map_meta_cap' => true,
            'has_archive' => false,
            'rewrite' => false,
        ]);

        register_post_type('assistant_memory', [
            'labels' => [
                'name' => 'Memory',
                'singular_name' => 'Memory Entry',
                'add_new_item' => 'Add Memory',
                'edit_item' => 'Edit Memory',
                'menu_name' => 'AI Memory',
            ],
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => false, // Managed via settings page DataView
            'show_in_rest' => true,
            'rest_base' => 'assistant-memory',
            'supports' => ['title', 'editor', 'revisions'],
            'capability_type' => 'post',
            'map_meta_cap' => true,
            'has_archive' => false,
            'rewrite' => false,
        ]);
    }

    public function registerToolProviders(Bridge\ToolRegistry $registry): void
    {
        // Register WP Abilities API tools (from gds-mcp and other ability providers)
        if (function_exists('wp_get_abilities')) {
            $registry->register(new Bridge\AbilitiesToolProvider);
        }

        // Skills CRUD tools (always available)
        $registry->register(new Bridge\SkillsToolProvider);

        // Memory tools (persistent knowledge base)
        $registry->register(new Bridge\MemoryToolProvider);

    }

    private function getPublishedSkills(): array
    {
        $posts = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'publish',
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
            'model' => get_post_meta($post->ID, '_assistant_model', true) ?: '',
        ], $posts);
    }

    public function runCleanup(): void
    {
        $days = apply_filters('gds-assistant/retention_days', 30);

        (new Storage\ConversationStore)->prune($days);
        (new Storage\AuditLog)->prune($days);
    }

    public function activate(): void
    {
        Storage\ConversationStore::createTables();
        Storage\AuditLog::createTables();

        if (! wp_next_scheduled('gds_assistant_cleanup')) {
            wp_schedule_event(time(), 'daily', 'gds_assistant_cleanup');
        }
    }

    public function deactivate(): void
    {
        wp_clear_scheduled_hook('gds_assistant_cleanup');
    }
}
