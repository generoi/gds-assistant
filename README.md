# GDS Assistant

AI-powered admin assistant for WordPress. Provides a chat interface in the admin panel where editors can interact with an LLM to manage site content using WordPress tools.

Built on [assistant-ui](https://www.assistant-ui.com/) for the chat UI and the [WordPress Abilities API](https://github.com/WordPress/abilities-api) for tool execution.

## Requirements

- PHP >= 8.3
- WordPress >= 6.8
- [generoi/gds-mcp](https://github.com/generoi/gds-mcp) (provides WordPress tools)
- An Anthropic API key (other LLM providers can be added)

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

```env
# Required
GDS_ASSISTANT_API_KEY=sk-ant-...

# Optional (sensible defaults)
GDS_ASSISTANT_MODEL=claude-sonnet-4-20250514
GDS_ASSISTANT_MAX_TOKENS=4096
```

### Filters

| Filter                         | Default                               | Description                                 |
| ------------------------------ | ------------------------------------- | ------------------------------------------- |
| `gds-assistant/capability`     | `edit_posts`                          | Minimum user capability to access the chat  |
| `gds-assistant/retention_days` | `30`                                  | Days before conversations are auto-deleted  |
| `gds-assistant/max_iterations` | `25`                                  | Maximum agentic loop iterations per message |
| `gds-assistant/rate_limit`     | `['requests' => 20, 'window' => 300]` | Per-user rate limit                         |
| `gds-assistant/system_prompt`  | (auto-generated)                      | Customize the system prompt                 |
| `gds-assistant/tools`          | (all registered)                      | Filter available tools                      |
| `gds-assistant/provider`       | `AnthropicProvider`                   | Swap the LLM provider                       |

## Architecture

### LLM Provider

The LLM provider is swappable via the `LlmProviderInterface`. Ships with `AnthropicProvider` (Claude via raw curl streaming). Add your own by implementing the interface and hooking `gds-assistant/provider`.

### Tool Bridge

Tools are sourced from WordPress Abilities API via `AbilitiesToolProvider`. The `ToolProviderInterface` allows registering additional tool sources (remote MCP servers, custom tools). Hook into `gds-assistant/register_tools` to add providers.

### Streaming

The chat endpoint (`POST /wp-json/gds-assistant/v1/chat`) streams Server-Sent Events (SSE). The entire agentic loop (LLM response → tool execution → re-prompt) runs server-side in a single SSE connection. No WebSockets required.

### Storage

- **Conversations**: `{prefix}_gds_assistant_conversations` — messages, token usage, per-user
- **Audit log**: `{prefix}_gds_assistant_audit_log` — every tool execution with input/result
- **Cleanup**: Daily WP-Cron prunes old records based on `gds-assistant/retention_days`

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

Or run a specific test:

```bash
npx @wordpress/env run tests-cli --env-cwd=wp-content/plugins/gds-assistant \
  vendor/bin/phpunit --filter=ToolRegistryTest
```

## License

MIT
