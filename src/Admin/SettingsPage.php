<?php

namespace GeneroWP\Assistant\Admin;

use GeneroWP\Assistant\Api\McpAuthEndpoint;
use GeneroWP\Assistant\Llm\ProviderRegistry;
use GeneroWP\Assistant\Llm\SystemPrompt;
use GeneroWP\Assistant\Mcp\ServerRegistry;
use GeneroWP\Assistant\Mcp\TokenStore;
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

        // Trusted web-fetch hosts. Managed by gds-mcp's WebFetchAbility but
        // exposed here so admins can review/edit/revoke user-approved hosts.
        register_setting('gds_assistant', 'gds_mcp_trusted_web_hosts', [
            'type' => 'array',
            'default' => [],
            'sanitize_callback' => [self::class, 'sanitizeTrustedHosts'],
        ]);

        // API keys are env-only for security — not stored in DB
    }

    /**
     * Sanitize the trusted web-fetch hosts list: accepts a newline or
     * comma-separated string from the textarea, normalizes to lowercase
     * hostnames without scheme/path, deduplicates.
     */
    public static function sanitizeTrustedHosts(mixed $input): array
    {
        if (is_string($input)) {
            $input = preg_split('/[\s,]+/', $input) ?: [];
        }
        if (! is_array($input)) {
            return [];
        }

        $clean = [];
        foreach ($input as $entry) {
            $entry = trim((string) $entry);
            if ($entry === '') {
                continue;
            }
            // Strip scheme and path if user pasted a full URL.
            $host = wp_parse_url(str_contains($entry, '://') ? $entry : "https://{$entry}", PHP_URL_HOST);
            if ($host) {
                $clean[] = strtolower($host);
            }
        }

        return array_values(array_unique($clean));
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

                <h2><?php esc_html_e('Trusted web-fetch hosts', 'gds-assistant'); ?></h2>
                <p class="description">
                    <?php esc_html_e('Hosts the assistant can fetch without asking for approval each time. One per line. Hosts approved via the chat\'s "Approve & trust" button appear here. The current site and any WordPress-allowed redirect hosts are implicitly trusted.', 'gds-assistant'); ?>
                </p>
                <?php
                $trustedHosts = (array) get_option('gds_mcp_trusted_web_hosts', []);
        ?>
                <textarea
                    name="gds_mcp_trusted_web_hosts"
                    rows="6"
                    class="large-text code"
                    placeholder="example.com&#10;docs.example.org"
                ><?php echo esc_textarea(implode("\n", $trustedHosts)); ?></textarea>

                <h2><?php esc_html_e('Providers', 'gds-assistant'); ?></h2>
                <p class="description"><?php esc_html_e('API keys are configured via environment variables in your .env file. The chat widget only loads when at least one provider is configured.', 'gds-assistant'); ?></p>
                <table class="form-table">
                    <?php foreach (self::getAllProviderConfigs() as $name => $config) { ?>
                        <?php $hasKey = ProviderRegistry::getApiKey($name); ?>
                        <tr>
                            <th scope="row"><?php echo esc_html($config['label']); ?></th>
                            <td>
                                <?php if ($hasKey) { ?>
                                    <span class="dashicons dashicons-yes-alt" style="color: green;"></span>
                                    <?php esc_html_e('Configured', 'gds-assistant'); ?>
                                <?php } else { ?>
                                    <span class="dashicons dashicons-minus" style="color: #999;"></span>
                                    <code><?php echo esc_html($config['env'][0] ?? ''); ?></code>
                                <?php } ?>
                            </td>
                        </tr>
                    <?php } ?>
                </table>

                <?php submit_button(); ?>
            </form>

            <?php $this->renderMcpSection(); ?>
        </div>
        <?php
    }

    /**
     * Connection panel for configured remote MCP servers.
     *
     * Rendered outside the options form so the connect/disconnect buttons
     * don't get submitted with regular settings saves.
     */
    private function renderMcpSection(): void
    {
        $servers = ServerRegistry::all();
        if (empty($servers)) {
            return;
        }

        $status = $_GET['mcp_connect'] ?? null;
        $statusMsg = isset($_GET['mcp_msg']) ? rawurldecode((string) $_GET['mcp_msg']) : '';

        ?>
        <h2><?php esc_html_e('MCP Servers', 'gds-assistant'); ?></h2>
        <p class="description">
            <?php esc_html_e('Remote Model Context Protocol servers whose tools should be available in the assistant. Configure servers via the gds-assistant/mcp_servers filter or GDS_ASSISTANT_MCP_SERVERS env var.', 'gds-assistant'); ?>
        </p>

        <?php if ($status === 'success') { ?>
            <div class="notice notice-success is-dismissible"><p><?php esc_html_e('MCP connection established.', 'gds-assistant'); ?></p></div>
        <?php } elseif ($status === 'error') { ?>
            <div class="notice notice-error is-dismissible"><p><?php echo esc_html($statusMsg ?: __('MCP connection failed.', 'gds-assistant')); ?></p></div>
        <?php } ?>

        <table class="form-table">
            <?php foreach ($servers as $server) {
                $isOauth = $server->authType() === 'oauth';
                $connected = $isOauth ? TokenStore::userHasToken($server->name, get_current_user_id()) : true; ?>
                <tr>
                    <th scope="row"><?php echo esc_html($server->displayLabel()); ?></th>
                    <td>
                        <code style="font-size: 11px;"><?php echo esc_html($server->url); ?></code><br>
                        <?php if (! $isOauth) { ?>
                            <span class="dashicons dashicons-yes-alt" style="color: green;"></span>
                            <?php printf(esc_html__('Auth: %s', 'gds-assistant'), esc_html($server->authType())); ?>
                        <?php } elseif ($connected) { ?>
                            <span class="dashicons dashicons-yes-alt" style="color: green;"></span>
                            <?php esc_html_e('Connected to your account', 'gds-assistant'); ?>
                            <button type="button" class="button button-link-delete" data-mcp-disconnect="<?php echo esc_attr($server->name); ?>" style="margin-left: 8px;">
                                <?php esc_html_e('Disconnect', 'gds-assistant'); ?>
                            </button>
                        <?php } else { ?>
                            <span class="dashicons dashicons-warning" style="color: #d63638;"></span>
                            <?php esc_html_e('Not connected for your user', 'gds-assistant'); ?>
                            <button type="button" class="button button-primary" data-mcp-connect="<?php echo esc_attr($server->name); ?>" style="margin-left: 8px;">
                                <?php esc_html_e('Connect', 'gds-assistant'); ?>
                            </button>
                        <?php } ?>
                        <?php if ($isOauth) { ?>
                            <p class="description" style="margin-top: 4px;">
                                <?php esc_html_e('Redirect URI:', 'gds-assistant'); ?>
                                <code><?php echo esc_html(McpAuthEndpoint::callbackUrl($server->name)); ?></code>
                            </p>
                        <?php } ?>
                    </td>
                </tr>
            <?php } ?>
        </table>

        <script>
        (function () {
            const nonce = <?php echo wp_json_encode(wp_create_nonce('wp_rest')); ?>;
            const restUrl = <?php echo wp_json_encode(rest_url('gds-assistant/v1/mcp/')); ?>;

            async function post(server, action) {
                const res = await fetch(restUrl + server + '/' + action, {
                    method: 'POST',
                    headers: { 'X-WP-Nonce': nonce },
                    credentials: 'same-origin',
                });
                if (!res.ok) {
                    const err = await res.text();
                    alert('MCP ' + action + ' failed: ' + err);
                    return null;
                }
                return res.json();
            }

            document.querySelectorAll('[data-mcp-connect]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    const data = await post(btn.dataset.mcpConnect, 'connect');
                    if (data && data.authorization_url) {
                        window.location.href = data.authorization_url;
                    } else {
                        btn.disabled = false;
                    }
                });
            });
            document.querySelectorAll('[data-mcp-disconnect]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Disconnect this MCP server?')) return;
                    btn.disabled = true;
                    await post(btn.dataset.mcpDisconnect, 'disconnect');
                    window.location.reload();
                });
            });
        })();
        </script>
        <?php
    }

    public function renderMemoryPage(): void
    {
        echo '<div class="wrap gds-assistant"><h1>'.__('AI Assistant Memory', 'gds-assistant').'</h1>';
        echo '<div id="gds-assistant-memory-dataview"></div>';
        echo '</div>';
    }

    public function renderSkillsPage(): void
    {
        echo '<div class="wrap gds-assistant"><h1>'.__('AI Assistant Skills', 'gds-assistant').'</h1>';
        echo '<div id="gds-assistant-skills-dataview"></div>';
        echo '</div>';
    }

    public function renderConversationsPage(): void
    {
        echo '<div class="wrap gds-assistant"><h1>'.__('Conversations', 'gds-assistant').'</h1>';
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
