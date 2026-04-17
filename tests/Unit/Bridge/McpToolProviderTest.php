<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\McpToolProvider;
use GeneroWP\Assistant\Mcp\ServerRegistry;
use GeneroWP\Assistant\Tests\TestCase;

class McpToolProviderTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        ServerRegistry::resetCache();
    }

    protected function tearDown(): void
    {
        remove_all_filters('gds-assistant/mcp_servers');
        ServerRegistry::resetCache();
        parent::tearDown();
    }

    public function test_tool_name_roundtrip(): void
    {
        $toolName = McpToolProvider::toolName('asana', 'create_task');
        $this->assertSame('mcp_asana__create_task', $toolName);

        [$server, $remote] = McpToolProvider::parseToolName($toolName);
        $this->assertSame('asana', $server);
        $this->assertSame('create_task', $remote);
    }

    public function test_parse_tool_name_returns_null_for_non_mcp(): void
    {
        $this->assertNull(McpToolProvider::parseToolName('gds__posts-list'));
        $this->assertNull(McpToolProvider::parseToolName('assistant__memory-list'));
    }

    public function test_tool_name_preserves_hyphens_in_remote_name(): void
    {
        // MCP tools commonly use hyphenated names — we must not mangle them
        // so tools/call routes back to the exact remote identifier.
        $toolName = McpToolProvider::toolName('figma', 'get-file');
        $this->assertSame('mcp_figma__get-file', $toolName);

        [$server, $remote] = McpToolProvider::parseToolName($toolName);
        $this->assertSame('figma', $server);
        $this->assertSame('get-file', $remote);
    }

    public function test_handles_only_mcp_prefixed_names(): void
    {
        $provider = new McpToolProvider;
        $this->assertTrue($provider->handles('mcp_asana__create_task'));
        $this->assertFalse($provider->handles('gds__posts-list'));
        $this->assertFalse($provider->handles('assistant__memory-save'));
    }

    public function test_returns_empty_when_no_servers_configured(): void
    {
        $provider = new McpToolProvider;
        $this->assertSame([], $provider->getTools());
    }

    public function test_execute_rejects_unknown_tool(): void
    {
        $provider = new McpToolProvider;
        $result = $provider->executeTool('mcp_nonexistent__foo', []);
        $this->assertWPError($result);
        $this->assertSame('mcp_tool_not_found', $result->get_error_code());
    }

    public function test_server_registry_reads_filter_config(): void
    {
        add_filter('gds-assistant/mcp_servers', fn () => [
            'asana' => [
                'url' => 'https://mcp.asana.com/sse',
                'label' => 'Asana',
                'auth' => ['type' => 'oauth', 'scopes' => ['default']],
            ],
        ]);
        ServerRegistry::resetCache();

        $servers = ServerRegistry::all();
        $this->assertArrayHasKey('asana', $servers);
        $this->assertSame('https://mcp.asana.com/sse', $servers['asana']->url);
        $this->assertSame('oauth', $servers['asana']->authType());
        $this->assertSame('Asana', $servers['asana']->displayLabel());
    }

    public function test_server_registry_rejects_invalid_names(): void
    {
        add_filter('gds-assistant/mcp_servers', fn () => [
            'has-dashes' => ['url' => 'https://x.example'],
            'valid_name' => ['url' => 'https://y.example'],
        ]);
        ServerRegistry::resetCache();

        $servers = ServerRegistry::all();
        $this->assertArrayNotHasKey('has-dashes', $servers);
        $this->assertArrayHasKey('valid_name', $servers);
    }
}
