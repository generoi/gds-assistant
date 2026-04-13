# GDS Assistant

AI-powered admin assistant for WordPress. Provides a chat interface in the admin panel where editors can interact with an LLM to manage site content using WordPress tools.

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
