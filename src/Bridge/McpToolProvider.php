<?php

namespace GeneroWP\Assistant\Bridge;

use GeneroWP\Assistant\Mcp\McpClient;
use GeneroWP\Assistant\Mcp\McpServerConfig;
use GeneroWP\Assistant\Mcp\ServerRegistry;

/**
 * Exposes tools from remote MCP servers to the gds-assistant tool bridge.
 *
 * Tool names are namespaced `mcp_{server}__{tool}` so multiple servers can
 * co-exist without collision. Server names are validated to [a-z0-9_]+ by
 * McpServerConfig so this mapping is unambiguous.
 *
 * Per-server tool definitions are cached in a transient (default 5 min) to
 * avoid re-running initialize → tools/list on every chat turn.
 */
class McpToolProvider implements ToolProviderInterface
{
    public const PREFIX = 'mcp_';

    public const SEPARATOR = '__';

    /** Cache TTL for tools/list results, in seconds. Short — server catalogs can change. */
    private const TOOLS_CACHE_TTL = 300;

    /** @var array<string, array>|null In-request cache: tool name → tool def (with _server key) */
    private ?array $toolMap = null;

    private ?int $userId = null;

    public function __construct(?int $userId = null)
    {
        $this->userId = $userId;
    }

    private function currentUserId(): int
    {
        return $this->userId ?? get_current_user_id();
    }

    public function getTools(): array
    {
        $this->ensureLoaded();

        return array_values(array_map(
            static fn (array $tool) => [
                'name' => $tool['name'],
                'description' => $tool['description'],
                'input_schema' => $tool['input_schema'],
            ],
            $this->toolMap ?? [],
        ));
    }

    public function executeTool(string $name, array $input): mixed
    {
        $this->ensureLoaded();

        $entry = $this->toolMap[$name] ?? null;
        if (! $entry) {
            // Fallback: underscore-for-hyphen normalization (LLMs sometimes
            // rewrite tool names). Mirrors AbilitiesToolProvider's logic.
            foreach ($this->toolMap ?? [] as $key => $candidate) {
                if (str_replace('-', '_', $key) === $name) {
                    $entry = $candidate;
                    $name = $key;
                    break;
                }
            }
        }
        if (! $entry) {
            return new \WP_Error('mcp_tool_not_found', "Unknown MCP tool: {$name}");
        }

        $server = ServerRegistry::get($entry['_server']);
        if (! $server) {
            return new \WP_Error('mcp_server_gone', "MCP server '{$entry['_server']}' is no longer configured");
        }

        $userId = $this->currentUserId();
        $client = new McpClient($server, ServerRegistry::auth($server, $userId));

        return $client->callTool($entry['_remote_name'], $input);
    }

    public function handles(string $name): bool
    {
        return str_starts_with($name, self::PREFIX);
    }

    /* ------------------------------ Internals ------------------------------ */

    private function ensureLoaded(): void
    {
        if ($this->toolMap !== null) {
            return;
        }

        $this->toolMap = [];
        foreach (ServerRegistry::all() as $server) {
            if (! $server->enabled) {
                continue;
            }
            foreach ($this->loadServerTools($server) as $tool) {
                $toolName = self::toolName($server->name, $tool['name']);
                $this->toolMap[$toolName] = [
                    'name' => $toolName,
                    'description' => self::decorateDescription($server, $tool),
                    'input_schema' => self::normalizeSchema($tool['inputSchema'] ?? null),
                    '_server' => $server->name,
                    '_remote_name' => $tool['name'],
                ];
            }
        }
    }

    /** @return array<int, array> */
    private function loadServerTools(McpServerConfig $server): array
    {
        $userId = $this->currentUserId();
        $auth = ServerRegistry::auth($server, $userId);
        if (! $auth->isAuthenticated()) {
            return [];
        }

        // For OAuth servers the tool catalog may differ by upstream account,
        // so cache per-user. Bearer/none auth is site-wide so no scoping needed.
        $cacheKey = 'gds_assistant_mcp_tools_'.$server->name;
        if ($server->authType() === 'oauth') {
            $cacheKey .= '_u'.$userId;
        }
        $cached = get_transient($cacheKey);
        if (is_array($cached)) {
            return $cached;
        }

        $client = new McpClient($server, $auth);
        $tools = $client->listTools();
        if (is_wp_error($tools)) {
            error_log("[gds-assistant] Failed to list MCP tools for {$server->name}: {$tools->get_error_message()}");

            return [];
        }

        set_transient($cacheKey, $tools, self::TOOLS_CACHE_TTL);

        return $tools;
    }

    public static function toolName(string $serverName, string $remoteName): string
    {
        return self::PREFIX.$serverName.self::SEPARATOR.$remoteName;
    }

    /**
     * @return array{0: string, 1: string}|null [server_name, remote_tool_name]
     */
    public static function parseToolName(string $name): ?array
    {
        if (! str_starts_with($name, self::PREFIX)) {
            return null;
        }
        $rest = substr($name, strlen(self::PREFIX));
        $pos = strpos($rest, self::SEPARATOR);
        if ($pos === false) {
            return null;
        }

        return [substr($rest, 0, $pos), substr($rest, $pos + strlen(self::SEPARATOR))];
    }

    private static function decorateDescription(McpServerConfig $server, array $tool): string
    {
        $desc = (string) ($tool['description'] ?? '');
        $label = $server->displayLabel();

        // Prefix with server label so the LLM knows which service a tool belongs to.
        return "[{$label}] ".$desc;
    }

    /** Ensure we always send a valid JSON Schema object to the LLM. */
    private static function normalizeSchema(mixed $schema): array
    {
        if (! is_array($schema) || ! isset($schema['type'])) {
            return ['type' => 'object', 'properties' => (object) []];
        }
        if (isset($schema['properties']) && $schema['properties'] === []) {
            $schema['properties'] = (object) [];
        }

        return $schema;
    }
}
