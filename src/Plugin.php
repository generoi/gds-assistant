<?php

namespace GeneroWP\Assistant;

class Plugin
{
    protected static $instance;

    public readonly string $file;

    public readonly string $path;

    public readonly string $url;

    /**
     * Get an environment variable with fallback to wp-config.php constants.
     */
    public static function env(string $key, mixed $default = null): mixed
    {
        if (function_exists('env')) {
            return env($key, $default);
        }

        $value = getenv($key);
        if ($value !== false) {
            return $value;
        }

        if (defined($key)) {
            return constant($key);
        }

        return $default;
    }

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
        add_action('enqueue_block_editor_assets', [$this, 'enqueueSkillEditorAssets']);
        add_action('gds-assistant/register_tools', [$this, 'registerToolProviders']);
        add_action('gds_assistant_cleanup', [$this, 'runCleanup']);
        add_action('gds_assistant_run_scheduled_skills', [Cron\SkillScheduler::class, 'run']);

        add_action('rest_insert_attachment', [$this, 'tagAssistantUpload']);

        // Bust system prompt cache when relevant data changes
        add_action('update_option_gds_assistant_custom_prompt', [Llm\SystemPrompt::class, 'bustCache']);
        add_action('update_option_gds_assistant_auto_memory', [Llm\SystemPrompt::class, 'bustCache']);
        add_action('save_post_assistant_memory', [Llm\SystemPrompt::class, 'bustCache']);
        add_action('delete_post', function (int $postId) {
            if (get_post_type($postId) === 'assistant_memory') {
                Llm\SystemPrompt::bustCache();
            }
        });

        // Settings page
        new Admin\SettingsPage($this);

        // CLI — only active when WP-CLI is loaded.
        Cli\AuditCommand::register();

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
        $defaultMaxTokens = (int) (self::env('GDS_ASSISTANT_MAX_TOKENS') ?: 4096);

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

        $mcpAuthEndpoint = new Api\McpAuthEndpoint;
        $mcpAuthEndpoint->register();
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

        register_post_meta('assistant_skill', '_assistant_model', [
            'show_in_rest' => true,
            'single' => true,
            'type' => 'string',
            'default' => '',
        ]);
        register_post_meta('assistant_skill', '_assistant_schedule', [
            'show_in_rest' => true,
            'single' => true,
            'type' => 'string',
            'default' => '',
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

        // Install bundled default skills on first load after upgrade. Runs
        // in init (not activation) because activation hooks don't fire
        // when updating via Composer — and the version gate makes it cheap.
        Bridge\DefaultSkills::maybeInstall();
    }

    public function tagAssistantUpload(\WP_Post $attachment): void
    {
        if (! empty($_GET['gds_assistant'])) {
            update_post_meta($attachment->ID, '_gds_assistant_upload', '1');
        }
    }

    public function enqueueSkillEditorAssets(): void
    {
        $screen = get_current_screen();
        if (! $screen || $screen->post_type !== 'assistant_skill') {
            return;
        }

        $assetFile = $this->path.'/build/skill-editor.asset.php';
        if (! file_exists($assetFile)) {
            return;
        }

        $asset = require $assetFile;
        wp_enqueue_script(
            'gds-assistant-skill-editor',
            $this->url.'/build/skill-editor.js',
            $asset['dependencies'],
            $asset['version'],
            true,
        );

        // Pass model options to JS
        $modelConfig = Llm\ProviderRegistry::getModelsForFrontend();
        wp_localize_script('gds-assistant-skill-editor', 'gdsAssistantSkill', [
            'models' => $modelConfig['providers'] ?? [],
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

        // Remote MCP server tools (Asana, Figma, etc.) — only registers if
        // gds-assistant/mcp_servers or GDS_ASSISTANT_MCP_SERVERS is set.
        if (! empty(Mcp\ServerRegistry::all())) {
            $registry->register(new Bridge\McpToolProvider);
        }
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
        Bridge\DefaultSkills::maybeInstall();

        if (! wp_next_scheduled('gds_assistant_cleanup')) {
            wp_schedule_event(time(), 'daily', 'gds_assistant_cleanup');
        }
        if (! wp_next_scheduled('gds_assistant_run_scheduled_skills')) {
            wp_schedule_event(time(), 'hourly', 'gds_assistant_run_scheduled_skills');
        }
    }

    public function deactivate(): void
    {
        wp_clear_scheduled_hook('gds_assistant_cleanup');
        wp_clear_scheduled_hook('gds_assistant_run_scheduled_skills');
    }
}
