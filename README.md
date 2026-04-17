# GDS Assistant

AI chat assistant built into the WordPress admin. Talk to it in natural language to manage your site — create pages, edit content, run audits, handle translations, and more.

### What it does

- **Chat with AI in your admin** — a floating chat widget on every admin page. Ask it to do things like "create a draft campaign page" or "find all pages with broken links" and it actually does them using your site's real data.
- **Multiple AI providers** — supports Claude (Anthropic), GPT (OpenAI), Gemini (Google), Mistral, Groq, xAI, and DeepSeek. Pick the model that fits the task — cheap and fast for quick queries, powerful for complex operations. Switch mid-conversation.
- **Skills** — save reusable prompts as skills (like macros). Create them through the chat or in WP Admin under Tools > AI Skills. Invoke with `/skill-name`. Each skill can have a preferred model — e.g. use a cheap model for lookups, a smart one for content creation.
- **Conversation history** — past chats are saved and searchable. Pick up where you left off. See how much each conversation cost.
- **Cost tracking** — live token count and estimated cost displayed as you chat. Price indicators ($-$$$$) next to each model so you know what you're spending.
- **Works with your content** — the assistant can list, create, update, and delete posts, pages, products, media, translations, forms, blocks, and more. It sees your actual site structure and uses real WordPress APIs.

Built on [assistant-ui](https://www.assistant-ui.com/) for the chat UI and the [WordPress Abilities API](https://github.com/WordPress/abilities-api) for tool execution.

## Requirements

- PHP >= 8.3
- WordPress >= 6.8
- [generoi/gds-mcp](https://github.com/generoi/gds-mcp) (provides WordPress tools)
- At least one AI provider API key configured

## Installation

```bash
composer install
npm install
npm run build
wp plugin activate gds-assistant
```

## Configuration

All configuration via environment variables and filters. No settings page.

### Environment Variables

Set API keys for the providers you want to use. The chat widget only loads if at least one provider is configured.

#### Provider API Keys

Each provider checks multiple env var names (first match wins):

| Provider               | Env vars (checked in order)                                                 | Get a key                                               |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Anthropic** (Claude) | `GDS_ASSISTANT_ANTHROPIC_KEY`, `GDS_ASSISTANT_API_KEY`, `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/) |
| **OpenAI**             | `GDS_ASSISTANT_OPENAI_KEY`, `OPENAI_API_KEY`                                | [platform.openai.com](https://platform.openai.com/)     |
| **Google Gemini**      | `GDS_ASSISTANT_GEMINI_KEY`, `GOOGLE_AI_API_KEY`                             | [aistudio.google.com](https://aistudio.google.com/)     |
| **Mistral**            | `GDS_ASSISTANT_MISTRAL_KEY`, `MISTRAL_API_KEY`                              | [console.mistral.ai](https://console.mistral.ai/)       |
| **Groq**               | `GDS_ASSISTANT_GROQ_KEY`, `GROQ_API_KEY`                                    | [console.groq.com](https://console.groq.com/)           |
| **xAI** (Grok)         | `GDS_ASSISTANT_XAI_KEY`, `XAI_API_KEY`                                      | [console.x.ai](https://console.x.ai/)                   |
| **DeepSeek**           | `GDS_ASSISTANT_DEEPSEEK_KEY`, `DEEPSEEK_API_KEY`                            | [platform.deepseek.com](https://platform.deepseek.com/) |

#### Other Settings

```env
# Optional — override the default provider (first available is used otherwise)
GDS_ASSISTANT_DEFAULT_PROVIDER=anthropic

# Optional — default max output tokens (default: 4096)
GDS_ASSISTANT_MAX_TOKENS=4096
```

#### Example .env

```env
# Anthropic (Claude) — primary provider
GDS_ASSISTANT_ANTHROPIC_KEY=sk-ant-api03-...

# OpenAI — secondary provider
GDS_ASSISTANT_OPENAI_KEY=sk-proj-...

# Gemini — cheap option for quick queries
GDS_ASSISTANT_GEMINI_KEY=AIza...
```

### Available Models

Models are grouped by provider in the chat widget dropdown. Only providers with configured API keys appear.

| Provider      | Model Key                 | Label          | Notes                          |
| ------------- | ------------------------- | -------------- | ------------------------------ |
| **Anthropic** | `anthropic:haiku`         | Haiku          | Fast, cheap                    |
|               | `anthropic:sonnet`        | Sonnet         | Best balance (default)         |
|               | `anthropic:opus`          | Opus           | Most capable                   |
|               | `anthropic:haiku-advisor` | Haiku+Advisor  | Haiku executor + Opus advisor  |
|               | `anthropic:advisor`       | Sonnet+Advisor | Sonnet executor + Opus advisor |
| **OpenAI**    | `openai:gpt-4.1-mini`     | GPT-4.1 Mini   | Fast, affordable               |
|               | `openai:gpt-4.1`          | GPT-4.1        | Strong tool use                |
|               | `openai:o4-mini`          | o4 Mini        | Reasoning model                |
| **Gemini**    | `gemini:gemini-flash`     | Flash 2.5      | Very cheap                     |
|               | `gemini:gemini-pro`       | Pro 2.5        | Near-Opus quality              |
| **Mistral**   | `mistral:mistral-large`   | Large          | EU-hosted                      |
| **Groq**      | `groq:llama-scout`        | Llama Scout    | Ultra-fast inference           |
|               | `groq:llama-maverick`     | Llama Maverick | Larger Llama model             |
| **xAI**       | `xai:grok-3`              | Grok 3         | Full model                     |
|               | `xai:grok-3-fast`         | Grok 3 Fast    | Faster variant                 |
| **DeepSeek**  | `deepseek:deepseek-chat`  | DeepSeek Chat  | Cheapest option                |

### Filters

| Filter                             | Default                               | Description                                 |
| ---------------------------------- | ------------------------------------- | ------------------------------------------- |
| `gds-assistant/capability`         | `edit_posts`                          | Minimum user capability to access the chat  |
| `gds-assistant/retention_days`     | `30`                                  | Days before conversations are auto-deleted  |
| `gds-assistant/max_iterations`     | `25`                                  | Maximum agentic loop iterations per message |
| `gds-assistant/rate_limit`         | `['requests' => 20, 'window' => 300]` | Per-user rate limit                         |
| `gds-assistant/system_prompt`      | (auto-generated)                      | Customize the system prompt                 |
| `gds-assistant/tools`              | (all registered)                      | Filter available tools                      |
| `gds-assistant/provider`           | (from registry)                       | Override the LLM provider instance          |
| `gds-assistant/register_providers` | —                                     | Action to register custom providers         |
| `gds-assistant/register_tools`     | —                                     | Action to register custom tool providers    |

## Architecture

### LLM Providers

Three provider implementations ship out of the box:

- **AnthropicProvider** — Claude models with streaming + advisor tool support
- **OpenAiCompatibleProvider** — Covers OpenAI, Mistral, Groq, xAI, and DeepSeek (same API format, different base URLs)
- **GeminiProvider** — Google Gemini with function calling

The `ProviderRegistry` auto-discovers available providers from env vars and exposes them to the frontend model selector. Add custom providers via the `gds-assistant/register_providers` action.

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
