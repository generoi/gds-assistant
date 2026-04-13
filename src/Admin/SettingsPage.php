<?php

namespace GeneroWP\Assistant\Admin;

use GeneroWP\Assistant\Llm\ProviderRegistry;
use GeneroWP\Assistant\Llm\SystemPrompt;
use GeneroWP\Assistant\Plugin;

class SettingsPage
{
    public function __construct(
        private readonly Plugin $plugin,
    ) {
        add_action('admin_menu', [$this, 'addMenuPage']);
        add_action('admin_init', [$this, 'registerSettings']);
        add_action('admin_enqueue_scripts', [$this, 'enqueueAssets']);
    }

    public function addMenuPage(): void
    {
        add_menu_page(
            __('AI Assistant', 'gds-assistant'),
            __('AI Assistant', 'gds-assistant'),
            'manage_options',
            'gds-assistant',
            [$this, 'renderPage'],
            'dashicons-format-chat',
            80,
        );

        // Sub-pages
        add_submenu_page(
            'gds-assistant',
            __('Settings', 'gds-assistant'),
            __('Settings', 'gds-assistant'),
            'manage_options',
            'gds-assistant',
            [$this, 'renderPage'],
        );

        add_submenu_page(
            'gds-assistant',
            __('Memory', 'gds-assistant'),
            __('Memory', 'gds-assistant'),
            'manage_options',
            'gds-assistant-memory',
            [$this, 'renderMemoryPage'],
        );

        add_submenu_page(
            'gds-assistant',
            __('Skills', 'gds-assistant'),
            __('Skills', 'gds-assistant'),
            'manage_options',
            'gds-assistant-skills',
            [$this, 'renderSkillsPage'],
        );

        add_submenu_page(
            'gds-assistant',
            __('Conversations', 'gds-assistant'),
            __('Conversations', 'gds-assistant'),
            'manage_options',
            'gds-assistant-conversations',
            [$this, 'renderConversationsPage'],
        );
    }

    public function registerSettings(): void
    {
        register_setting('gds_assistant', 'gds_assistant_custom_prompt', [
            'type' => 'string',
            'default' => '',
            'sanitize_callback' => 'sanitize_textarea_field',
        ]);

        register_setting('gds_assistant', 'gds_assistant_auto_memory', [
            'type' => 'boolean',
            'default' => true,
        ]);

        // Provider API keys (stored in DB, env var takes precedence)
        foreach (ProviderRegistry::getAvailable() + self::getAllProviderConfigs() as $name => $config) {
            register_setting('gds_assistant_providers', "gds_assistant_key_{$name}", [
                'type' => 'string',
                'sanitize_callback' => 'sanitize_text_field',
            ]);
        }
    }

    public function enqueueAssets(string $hookSuffix): void
    {
        // Only on our settings pages
        if (! str_contains($hookSuffix, 'gds-assistant')) {
            return;
        }

        $assetFile = $this->plugin->path.'/build/admin-settings.asset.php';
        if (! file_exists($assetFile)) {
            return;
        }

        $asset = require $assetFile;

        wp_enqueue_script(
            'gds-assistant-settings',
            $this->plugin->url.'/build/admin-settings.js',
            $asset['dependencies'],
            $asset['version'],
            true,
        );

        wp_enqueue_style(
            'gds-assistant-settings',
            $this->plugin->url.'/build/admin-settings.css',
            ['wp-components'],
            $asset['version'],
        );
    }

    public function renderPage(): void
    {
        $customPrompt = get_option('gds_assistant_custom_prompt', '');
        $autoMemory = get_option('gds_assistant_auto_memory', true);
        $available = ProviderRegistry::getAvailable();

        ?>
        <div class="wrap">
            <h1><?php esc_html_e('AI Assistant Settings', 'gds-assistant'); ?></h1>

            <form method="post" action="options.php">
                <?php settings_fields('gds_assistant'); ?>

                <h2><?php esc_html_e('System Prompt', 'gds-assistant'); ?></h2>

                <h3><?php esc_html_e('Auto-generated (read-only)', 'gds-assistant'); ?></h3>
                <p class="description"><?php esc_html_e('This is automatically generated from your site configuration. It is always included.', 'gds-assistant'); ?></p>
                <textarea readonly rows="6" class="large-text code" style="background: #f9f9f9; color: #666;"><?php echo esc_textarea(SystemPrompt::build()); ?></textarea>

                <h3><?php esc_html_e('Custom additions', 'gds-assistant'); ?></h3>
                <p class="description"><?php esc_html_e('Additional instructions appended to the system prompt. Use this for site-specific rules or preferences.', 'gds-assistant'); ?></p>
                <textarea name="gds_assistant_custom_prompt" rows="6" class="large-text code"><?php echo esc_textarea($customPrompt); ?></textarea>

                <h2><?php esc_html_e('Memory', 'gds-assistant'); ?></h2>
                <label>
                    <input type="checkbox" name="gds_assistant_auto_memory" value="1" <?php checked($autoMemory); ?>>
                    <?php esc_html_e('Auto-learn: Allow the assistant to save useful facts it discovers to memory', 'gds-assistant'); ?>
                </label>

                <h2><?php esc_html_e('Providers', 'gds-assistant'); ?></h2>
                <p class="description"><?php esc_html_e('API keys can also be set via environment variables (env takes precedence).', 'gds-assistant'); ?></p>
                <table class="form-table">
                    <?php foreach (self::getAllProviderConfigs() as $name => $config) { ?>
                        <?php
                        $envKey = ProviderRegistry::getApiKey($name);
                        $dbKey = get_option("gds_assistant_key_{$name}", '');
                        $hasKey = $envKey || $dbKey;
                        ?>
                        <tr>
                            <th scope="row"><?php echo esc_html($config['label']); ?></th>
                            <td>
                                <?php if ($envKey) { ?>
                                    <span class="dashicons dashicons-yes-alt" style="color: green;"></span>
                                    <?php esc_html_e('Set via environment variable', 'gds-assistant'); ?>
                                <?php } else { ?>
                                    <input type="password" name="gds_assistant_key_<?php echo esc_attr($name); ?>"
                                        value="<?php echo esc_attr($dbKey); ?>"
                                        class="regular-text"
                                        placeholder="<?php echo esc_attr($config['env'][0] ?? ''); ?>">
                                    <?php if ($dbKey) { ?>
                                        <span class="dashicons dashicons-yes-alt" style="color: green;"></span>
                                    <?php } ?>
                                <?php } ?>
                            </td>
                        </tr>
                    <?php } ?>
                </table>

                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    public function renderMemoryPage(): void
    {
        echo '<div class="wrap"><h1>'.__('AI Assistant Memory', 'gds-assistant').'</h1>';
        echo '<div id="gds-assistant-memory-dataview"></div>';
        echo '</div>';
    }

    public function renderSkillsPage(): void
    {
        echo '<div class="wrap"><h1>'.__('AI Assistant Skills', 'gds-assistant').'</h1>';
        echo '<div id="gds-assistant-skills-dataview"></div>';
        echo '</div>';
    }

    public function renderConversationsPage(): void
    {
        echo '<div class="wrap"><h1>'.__('Conversations', 'gds-assistant').'</h1>';
        echo '<div id="gds-assistant-conversations-dataview"></div>';
        echo '</div>';
    }

    /**
     * Get all provider configs (not just available ones).
     */
    private static function getAllProviderConfigs(): array
    {
        ProviderRegistry::registerDefaults();

        // Access via reflection since getAvailable() filters by key
        $available = [];
        $reflect = new \ReflectionClass(ProviderRegistry::class);
        $prop = $reflect->getProperty('providers');
        $prop->setAccessible(true);

        return $prop->getValue();
    }
}
