<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Llm\MessageLoop;
use GeneroWP\Assistant\Llm\ProviderRegistry;
use GeneroWP\Assistant\Llm\SystemPrompt;
use GeneroWP\Assistant\Plugin;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Storage\ConversationStore;
use Illuminate\Support\Facades\Log;
use WP_REST_Request;
use WP_REST_Response;

class ChatEndpoint
{
    public function __construct(
        private readonly Plugin $plugin,
    ) {}

    public function register(): void
    {
        register_rest_route('gds-assistant/v1', '/chat', [
            'methods' => 'POST',
            'callback' => [$this, 'handle'],
            'permission_callback' => [$this, 'checkPermission'],
            'args' => [
                'messages' => [
                    'required' => true,
                    'type' => 'array',
                ],
                'conversation_id' => [
                    'type' => 'string',
                    'default' => '',
                ],
                'model' => [
                    'type' => 'string',
                    'default' => '',
                    'description' => 'Model key in "provider:model" format (e.g. "anthropic:sonnet", "openai:gpt-4.1-mini").',
                ],
                'max_tokens' => [
                    'type' => 'integer',
                    'default' => 0,
                ],
                'system_context' => [
                    'type' => 'string',
                    'default' => '',
                ],
            ],
        ]);
    }

    public function checkPermission(): bool
    {
        $capability = apply_filters('gds-assistant/capability', 'edit_posts');

        return current_user_can($capability);
    }

    public function handle(WP_REST_Request $request): WP_REST_Response
    {
        if (! ProviderRegistry::hasAnyProvider()) {
            return new WP_REST_Response([
                'error' => 'No AI provider configured. Set an API key in .env (e.g. GDS_ASSISTANT_ANTHROPIC_KEY).',
            ], 500);
        }

        // Rate limit check
        $userId = get_current_user_id();
        $rateCheck = RateLimiter::check($userId);
        if (is_wp_error($rateCheck)) {
            return new WP_REST_Response([
                'error' => $rateCheck->get_error_message(),
            ], 429);
        }

        $messages = $request->get_param('messages');
        $conversationId = $request->get_param('conversation_id');

        // Normalize messages
        $messages = $this->normalizeMessages($messages);

        // Resolve model and provider
        $modelKey = $request->get_param('model') ?: ProviderRegistry::getDefaultModelKey();
        $requestMaxTokens = (int) $request->get_param('max_tokens');
        $envMaxTokens = (int) (env('GDS_ASSISTANT_MAX_TOKENS') ?: 0);
        $maxTokens = $requestMaxTokens ?: $envMaxTokens ?: 4096;

        $resolved = ProviderRegistry::resolve($modelKey, $maxTokens);
        if (! $resolved) {
            return new WP_REST_Response([
                'error' => "Model not available: {$modelKey}",
            ], 400);
        }

        $provider = $resolved['provider'];
        $modelId = $resolved['modelId'];

        // Resolve or create conversation
        $store = new ConversationStore;
        $model = $modelId;

        if ($conversationId) {
            $conversation = $store->get($conversationId);
            if (! $conversation || (int) $conversation['user_id'] !== $userId) {
                return new WP_REST_Response(['error' => 'Conversation not found'], 404);
            }
            // Prepend stored messages so the LLM has full context
            $storedMessages = $conversation['messages'] ?? [];
            if (! empty($storedMessages)) {
                $storedMessages = self::sanitizeMessages($storedMessages);
                $messages = array_merge($storedMessages, $messages);
            }
        } else {
            $conversationId = $store->create($userId, $model);
        }

        // Set up SSE headers
        $this->startSSE();

        // Send conversation ID to client
        $this->sendSSE('conversation_start', [
            'conversation_id' => $conversationId,
            'model' => $modelKey,
        ]);

        // Allow filter to override the provider
        $provider = apply_filters('gds-assistant/provider', $provider);

        // Build tool registry
        $toolRegistry = new ToolRegistry;
        do_action('gds-assistant/register_tools', $toolRegistry);

        // Run the agentic loop with audit logging
        $auditLog = new AuditLog;
        $loop = new MessageLoop(
            $provider,
            $toolRegistry,
            $auditLog,
            $conversationId,
            $userId,
        );

        try {
            $systemPrompt = SystemPrompt::build();
            $systemContext = trim($request->get_param('system_context') ?? '');
            if ($systemContext) {
                $systemPrompt .= "\n\nUser context for this chat:\n".$systemContext;
            }

            self::log('info', 'Chat request', [
                'conversation' => $conversationId,
                'user' => $userId,
                'model' => $modelId,
                'provider' => $provider->name(),
                'new_messages' => count($request->get_param('messages')),
                'total_messages' => count($messages),
            ]);

            $updatedMessages = $loop->run(
                $messages,
                function (string $type, array $data) use ($conversationId) {
                    $this->sendSSE($type, $data);

                    // Log tool events (tool_use_start has empty input — real input logged by MessageLoop)
                    if ($type === 'tool_use_start') {
                        self::log('info', 'Tool call: '.$data['name'], [
                            'conversation' => $conversationId,
                        ]);
                    } elseif ($type === 'tool_result' && ! empty($data['is_error'])) {
                        self::log('warning', 'Tool error: '.($data['tool_use_id'] ?? ''), [
                            'conversation' => $conversationId,
                            'result' => $data['result'] ?? null,
                        ]);
                    } elseif ($type === 'error') {
                        self::log('error', 'Stream error: '.($data['message'] ?? ''), [
                            'conversation' => $conversationId,
                        ]);
                    }
                },
                $systemPrompt,
            );

            self::log('info', 'Chat complete', [
                'conversation' => $conversationId,
                'input_tokens' => $loop->getInputTokens(),
                'output_tokens' => $loop->getOutputTokens(),
            ]);

            // Persist conversation (only set title on first save)
            $updateData = [
                'messages' => $updatedMessages,
                'total_input_tokens' => $loop->getInputTokens(),
                'total_output_tokens' => $loop->getOutputTokens(),
            ];

            $currentTitle = $conversation['title'] ?? '';
            if (! $currentTitle) {
                $updateData['title'] = $this->generateTitle($messages);
            }

            $store->update($conversationId, $updateData);
        } catch (\Throwable $e) {
            $this->sendSSE('error', ['message' => $e->getMessage()]);
            self::log('error', $e->getMessage(), [
                'conversation' => $conversationId,
                'file' => $e->getFile().':'.$e->getLine(),
                'trace' => $e->getTraceAsString(),
            ]);
        }

        exit;
    }

    private function normalizeMessages(array $messages): array
    {
        return array_map(function ($msg) {
            $role = $msg['role'] ?? 'user';
            $content = $msg['content'] ?? '';

            if (is_string($content)) {
                return ['role' => $role, 'content' => $content];
            }

            return ['role' => $role, 'content' => $content];
        }, $messages);
    }

    private function generateTitle(array $messages): string
    {
        // Use the first user message as conversation title
        foreach ($messages as $msg) {
            if (($msg['role'] ?? '') !== 'user') {
                continue;
            }

            $content = $msg['content'] ?? '';

            // Content can be a string or an array of content blocks
            if (is_array($content)) {
                // Skip tool_result arrays (from agentic loop)
                $textParts = array_filter($content, fn ($p) => is_array($p) && ($p['type'] ?? '') === 'text');
                $content = implode(' ', array_map(fn ($p) => $p['text'] ?? '', $textParts));
                if (! $content) {
                    continue; // tool_result-only user message, skip
                }
            }

            if (! is_string($content) || $content === '') {
                continue;
            }

            $title = trim($content);

            return mb_strlen($title) > 100
                ? mb_substr($title, 0, 97).'...'
                : $title;
        }

        return 'Untitled conversation';
    }

    /**
     * Fix stored messages that have invalid formats (e.g. tool_use input as [] instead of {}).
     */
    private static function sanitizeMessages(array $messages): array
    {
        return array_map(function (array $msg) {
            if (! is_array($msg['content'] ?? null)) {
                return $msg;
            }

            $msg['content'] = array_map(function ($block) {
                if (! is_array($block)) {
                    return $block;
                }
                // tool_use blocks: input must be an object, not an empty array
                if (($block['type'] ?? '') === 'tool_use' && isset($block['input']) && $block['input'] === []) {
                    $block['input'] = new \stdClass;
                }
                // server_tool_use blocks: same fix
                if (($block['type'] ?? '') === 'server_tool_use' && isset($block['input']) && $block['input'] === []) {
                    $block['input'] = new \stdClass;
                }

                return $block;
            }, $msg['content']);

            return $msg;
        }, $messages);
    }

    /**
     * Log with Laravel Log (Acorn) when available, error_log for errors.
     *
     * Levels: debug (tool calls/results), info (request lifecycle), warning (tool errors), error (exceptions).
     */
    private static function log(string $level, string $message, array $context = []): void
    {
        $prefixed = "[gds-assistant] {$message}";

        // Always error_log for warning/error — these should be visible regardless of Acorn
        if (in_array($level, ['warning', 'error'], true)) {
            error_log($prefixed.($context ? ' '.json_encode($context) : ''));
        }

        // Laravel Log for structured logging at all levels
        if (class_exists(Log::class)) {
            try {
                Log::$level($prefixed, $context);
            } catch (\Throwable) {
                // Acorn not booted
            }
        }
    }

    private function startSSE(): void
    {
        while (ob_get_level()) {
            ob_end_clean();
        }

        set_time_limit(0);

        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
    }

    private function sendSSE(string $event, array $data): void
    {
        echo "event: {$event}\n";
        echo 'data: '.json_encode($data)."\n\n";

        if (ob_get_level()) {
            ob_flush();
        }
        flush();
    }
}
