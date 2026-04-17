<?php

namespace GeneroWP\Assistant\Mcp;

/**
 * Minimal MCP client over the "Streamable HTTP" transport (2025-03-26 spec).
 *
 * Scope is what gds-assistant needs: `tools/list` and `tools/call`. Each call
 * runs a fresh initialize → request lifecycle, so we don't need to persist a
 * session across PHP requests (a limitation, but fine for listing and one-shot
 * tool calls; the `Mcp-Session-Id` header is still honored within a single
 * McpClient instance in case the server requires it).
 *
 * Responses may arrive as a single JSON object (Content-Type: application/json)
 * OR as a text/event-stream with one or more `message` events. We parse both.
 */
class McpClient
{
    private const PROTOCOL_VERSION = '2025-03-26';

    private ?string $sessionId = null;

    private int $requestId = 0;

    public function __construct(
        private readonly McpServerConfig $server,
        private readonly AuthStrategyInterface $auth,
    ) {}

    /** @return array<int, array{name: string, description?: string, inputSchema?: array}>|\WP_Error */
    public function listTools(): array|\WP_Error
    {
        $init = $this->initialize();
        if (is_wp_error($init)) {
            return $init;
        }

        $result = $this->request('tools/list', (object) []);
        if (is_wp_error($result)) {
            return $result;
        }

        return $result['tools'] ?? [];
    }

    /** @return mixed|\WP_Error Tool result content (already unwrapped) */
    public function callTool(string $name, array $arguments): mixed
    {
        $init = $this->initialize();
        if (is_wp_error($init)) {
            return $init;
        }

        $result = $this->request('tools/call', [
            'name' => $name,
            'arguments' => empty($arguments) ? (object) [] : $arguments,
        ]);
        if (is_wp_error($result)) {
            return $result;
        }

        if (! empty($result['isError'])) {
            $text = self::extractText($result['content'] ?? []);

            return new \WP_Error('mcp_tool_error', $text ?: 'MCP tool returned an error');
        }

        // For gds-assistant the LLM just needs readable output. Prefer text
        // content blocks; fall back to the raw structure if the server returns
        // something else (resource refs, images, etc.).
        $text = self::extractText($result['content'] ?? []);
        if ($text !== null) {
            return $text;
        }

        return $result['content'] ?? $result;
    }

    /* ------------------------------ Internals ------------------------------ */

    private function initialize(): bool|\WP_Error
    {
        if (! $this->auth->isAuthenticated()) {
            return new \WP_Error(
                'mcp_not_authenticated',
                "MCP server '{$this->server->name}' is not connected. Authorize it from the AI Assistant settings.",
            );
        }

        $result = $this->request('initialize', [
            'protocolVersion' => self::PROTOCOL_VERSION,
            'capabilities' => (object) [],
            'clientInfo' => [
                'name' => 'gds-assistant',
                'version' => '1.0',
            ],
        ]);
        if (is_wp_error($result)) {
            return $result;
        }

        // Spec requires the client to send `notifications/initialized` after
        // the handshake. It's a notification (no id, no response expected).
        $this->notify('notifications/initialized');

        return true;
    }

    private function request(string $method, mixed $params): array|\WP_Error
    {
        $payload = [
            'jsonrpc' => '2.0',
            'id' => ++$this->requestId,
            'method' => $method,
        ];
        if ($params !== null) {
            $payload['params'] = $params;
        }

        $response = $this->post($payload);
        if (is_wp_error($response)) {
            return $response;
        }

        // Retry once on 401 if the auth strategy can recover (e.g. OAuth refresh).
        $code = wp_remote_retrieve_response_code($response);
        if ($code === 401 && $this->auth->handleUnauthorized()) {
            $response = $this->post($payload);
            if (is_wp_error($response)) {
                return $response;
            }
            $code = wp_remote_retrieve_response_code($response);
        }

        if ($code >= 400) {
            return new \WP_Error(
                'mcp_http_error',
                "MCP server {$this->server->name} returned HTTP {$code}: ".wp_remote_retrieve_body($response),
            );
        }

        // Capture session id if the server issued one during initialize.
        $sessionId = wp_remote_retrieve_header($response, 'mcp-session-id');
        if ($sessionId) {
            $this->sessionId = $sessionId;
        }

        $message = $this->parseJsonRpcResponse($response);
        if (is_wp_error($message)) {
            return $message;
        }

        if (isset($message['error'])) {
            $err = $message['error'];
            $msg = $err['message'] ?? 'unknown error';
            $code = $err['code'] ?? 'mcp_error';

            return new \WP_Error('mcp_rpc_error', "MCP error ({$code}): {$msg}");
        }

        return $message['result'] ?? [];
    }

    private function notify(string $method, mixed $params = null): void
    {
        $payload = ['jsonrpc' => '2.0', 'method' => $method];
        if ($params !== null) {
            $payload['params'] = $params;
        }
        // Notifications get 202 Accepted with no body; we fire-and-forget.
        $this->post($payload);
    }

    private function post(array $payload): array|\WP_Error
    {
        $headers = array_merge([
            'Content-Type' => 'application/json',
            'Accept' => 'application/json, text/event-stream',
        ], $this->auth->headers());

        if ($this->sessionId) {
            $headers['Mcp-Session-Id'] = $this->sessionId;
        }

        return wp_remote_post($this->server->url, [
            'timeout' => 30,
            'headers' => $headers,
            'body' => wp_json_encode($payload),
        ]);
    }

    /**
     * Parse a JSON-RPC response that may arrive as either a JSON object or
     * an SSE stream. For SSE we return the first `message` event's data
     * (tools/list + tools/call return a single response message; we don't
     * yet support long-running streaming tool results).
     */
    private function parseJsonRpcResponse(array $response): array|\WP_Error
    {
        $body = wp_remote_retrieve_body($response);
        $contentType = (string) wp_remote_retrieve_header($response, 'content-type');

        if (str_starts_with($contentType, 'text/event-stream')) {
            $data = self::firstSseMessage($body);
            if ($data === null) {
                return new \WP_Error('mcp_empty_stream', 'MCP SSE response contained no message events');
            }

            return $data;
        }

        if ($body === '' || $body === null) {
            return ['result' => []];
        }

        $decoded = json_decode($body, true);
        if (! is_array($decoded)) {
            return new \WP_Error('mcp_invalid_json', "MCP response was not valid JSON: {$body}");
        }

        return $decoded;
    }

    private static function firstSseMessage(string $body): ?array
    {
        $buffer = '';
        foreach (preg_split("/\r?\n/", $body) as $line) {
            if ($line === '') {
                // Blank line terminates an event.
                if ($buffer !== '') {
                    $decoded = json_decode($buffer, true);
                    if (is_array($decoded)) {
                        return $decoded;
                    }
                    $buffer = '';
                }

                continue;
            }
            if (str_starts_with($line, 'data:')) {
                $buffer .= ltrim(substr($line, 5));
            }
        }
        if ($buffer !== '') {
            $decoded = json_decode($buffer, true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return null;
    }

    private static function extractText(array $content): ?string
    {
        $parts = [];
        foreach ($content as $block) {
            if (is_array($block) && ($block['type'] ?? null) === 'text' && isset($block['text'])) {
                $parts[] = (string) $block['text'];
            }
        }

        return $parts ? implode("\n", $parts) : null;
    }
}
