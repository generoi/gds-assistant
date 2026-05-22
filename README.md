# GDS Assistant

AI chat assistant built into the WordPress admin. Talk to it in natural language to manage your site — create pages, edit content, run audits, handle translations, and more.

### What it does

- **Chat with AI in your admin** — a floating chat widget on every admin page. Ask it to do things like "create a draft campaign page" or "find all pages with broken links" and it actually does them using your site's real data.
- **WordPress-native AI** — uses the WordPress 7 AI Client and Connectors APIs for provider routing and credentials. Configure providers once under Settings > Connectors.
- **Skills** — save reusable prompts as skills (like macros). Create them through the chat or in WP Admin under Tools > AI Skills. Invoke with `/skill-name`. Each skill can have a preferred model — e.g. use a cheap model for lookups, a smart one for content creation.
- **Conversation history** — past chats are saved and searchable. Pick up where you left off. See how much each conversation cost.
- **Cost tracking** — live token count and estimated cost displayed as you chat. Price indicators ($-$$$$) next to each model so you know what you're spending.
- **Works with your content** — the assistant can list, create, update, and delete posts, pages, products, media, translations, forms, blocks, and more. It sees your actual site structure and uses real WordPress APIs.

Built on [assistant-ui](https://www.assistant-ui.com/), the WordPress AI Client, WordPress Connectors, and the WordPress Abilities API.

## Requirements

- PHP >= 8.3
- WordPress >= 7.0
- [generoi/gds-mcp](https://github.com/generoi/gds-mcp) (provides WordPress tools)
- At least one WordPress AI provider connector configured

## Installation

```bash
composer install
npm install
npm run build
wp plugin activate gds-assistant
```

## Configuration

Configure AI providers through WordPress core under Settings > Connectors. The assistant does not store provider API keys.

### AI Providers

Install and configure a WordPress 7 AI provider plugin, then add its credentials under Settings > Connectors. Core handles provider discovery, credential source priority, and model routing.

The chat widget only loads when `wp_supports_ai()` is true and `wp_ai_client_prompt()` supports text generation.

### Other Settings

```env
# Optional — default max output tokens (default: 4096)
GDS_ASSISTANT_MAX_TOKENS=4096
```

### Available Models

The assistant exposes WordPress AI Client preferences, not vendor-specific transports:

| Model Key            | Label                       | Notes                                     |
| -------------------- | --------------------------- | ----------------------------------------- |
| `wordpress:auto`     | Auto                        | Let WordPress choose any suitable model   |
| `wordpress:fast`     | Fast available model        | Preference list for lower-cost responses  |
| `wordpress:balanced` | Balanced available model    | Preference list for general assistant use |
| `wordpress:capable`  | Most capable available model | Preference list for harder tool planning  |

Legacy skill model keys such as `anthropic:sonnet` are mapped to the closest WordPress preference.

### Filters

| Filter                             | Default                               | Description                                 |
| ---------------------------------- | ------------------------------------- | ------------------------------------------- |
| `gds-assistant/capability`         | `edit_posts`                          | Minimum user capability to access the chat  |
| `gds-assistant/retention_days`     | `30`                                  | Days before conversations are auto-deleted  |
| `gds-assistant/max_iterations`     | `25`                                  | Maximum agentic loop iterations per message |
| `gds-assistant/rate_limit`         | `['requests' => 20, 'window' => 300]` | Per-user rate limit                         |
| `gds-assistant/system_prompt`      | (auto-generated)                      | Customize the system prompt                 |
| `gds-assistant/tools`              | (all registered)                      | Filter available tools                      |
| `gds-assistant/register_tools`     | —                                     | Action to register custom tool providers    |

## Architecture

### AI Client

`CoreAiProvider` is the only LLM transport. It uses `wp_ai_client_prompt()` for generation and asks the model for structured JSON tool calls. Provider plugins, API keys, model routing, and AI availability are handled by WordPress core.

### Tool Bridge

Tools are sourced from WordPress Abilities API via `AbilitiesToolProvider`. The `ToolProviderInterface` allows registering additional tool sources. Hook into `gds-assistant/register_tools` to add providers.

### Remote MCP servers

The assistant can pull in tools from external Model Context Protocol servers (e.g. Asana, Figma, in-house MCPs). Each configured server's tools appear in the tool list as `mcp_{server}__{tool}` and route through `McpToolProvider`.

**Configuration** — register servers via the `gds-assistant/mcp_servers` filter or the `GDS_ASSISTANT_MCP_SERVERS` env var (JSON, same shape):

```php
add_filter('gds-assistant/mcp_servers', function ($servers) {
    $servers['asana'] = [
        'url'   => 'https://mcp.asana.com/sse',
        'label' => 'Asana',
        'auth'  => ['type' => 'oauth', 'scopes' => ['default']],
    ];

    $servers['internal'] = [
        'url'  => 'https://mcp.internal.example/mcp',
        'auth' => ['type' => 'bearer', 'env' => 'INTERNAL_MCP_TOKEN'],
    ];

    return $servers;
});
```

**Supported auth modes:**

| Type | Config | Notes |
| --- | --- | --- |
| `none` | `['type' => 'none']` | Public/unauthenticated MCP |
| `bearer` | `['type' => 'bearer', 'token' => '...']` or `['env' => 'NAME']` | Static API token |
| `oauth` | `['type' => 'oauth', 'scopes' => [...], 'client_id' => '...'?, 'client_secret' => '...'?]` | OAuth 2.1 + PKCE. Uses RFC 7591 dynamic client registration when `client_id` is omitted and the server supports it |

**OAuth connect flow:**

1. Configure the server via filter/env
2. Go to **AI Assistant → Settings** — configured servers appear in the "MCP Servers" section
3. Click **Connect** → the plugin discovers the auth server (RFC 9728 / RFC 8414), registers a client if needed, and redirects you to the provider's authorize page
4. After you approve, the callback at `/wp-json/gds-assistant/v1/mcp/{name}/callback` exchanges the code for tokens and stores them. Tokens are refreshed transparently on 401.

Server names must match `[a-z0-9_]+` (used in the tool-name namespace and callback URL).

**Token scope:**

- **OAuth servers** — tokens are per-user. Each admin connects their own upstream account (Asana, Figma, etc.) so tool calls act on behalf of whoever is chatting. Stored in `user_meta` with autoload off.
- **Bearer servers** — the token comes from config/env, so it's inherently site-wide. All admins share it.
- **Server metadata** (auth endpoints, DCR `client_id`/`client_secret`) is site-wide in `wp_options` — one registration per WP install, reused across users.

**Encryption at rest:** `access_token`, `refresh_token`, and any DCR-issued `client_secret` are encrypted with AES-256-GCM keyed from `wp_salt('auth')` (HKDF-SHA256). This is defense in depth, not a boundary — an attacker with DB access typically has `wp-config.php` too — but it stops casual DB dumps/backups/logs from leaking usable upstream-service tokens.

### Streaming

The chat endpoint (`POST /wp-json/gds-assistant/v1/chat`) streams Server-Sent Events (SSE). The entire agentic loop runs server-side in a single SSE connection. No WebSockets required.

### Storage

- **Conversations**: `{prefix}_gds_assistant_conversations` — messages, token usage, per-user
- **Audit log**: `{prefix}_gds_assistant_audit_log` — every tool execution with input/result
- **Cleanup**: Daily WP-Cron prunes old records based on `gds-assistant/retention_days`

### Skills

Reusable prompt templates stored as a custom post type (`assistant_skill`). Invoke via `/slug` in the chat. Manage in WP Admin under Tools > AI Skills, or ask the assistant to create them.

## Development

```bash
composer install
npm install
npm run build          # Production build
npm run start          # Watch mode
composer lint          # Check PHP code style
composer lint:fix      # Fix PHP code style
npm run lint           # Check JS/CSS code style
npm run lint:fix       # Fix JS/CSS code style
```

## Testing

```bash
npx @wordpress/env start
composer test:wp-env
npx @wordpress/env stop
```

## License

MIT
