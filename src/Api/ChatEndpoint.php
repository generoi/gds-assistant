<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Bridge\AbilitiesToolProvider;
use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Llm\ContextCompressor;
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
        $envMaxTokens = (int) (Plugin::env('GDS_ASSISTANT_MAX_TOKENS') ?: 0);
        $maxTokens = $requestMaxTokens ?: $envMaxTokens ?: 4096;

        $resolved = ProviderRegistry::resolve($modelKey, $maxTokens);
        if (! $resolved) {
            return new WP_REST_Response([
                'error' => "Model not available: {$modelKey}",
            ], 400);
        }

        $provider = $resolved['provider'];
        $modelId = $resolved['modelId'];
        $modelTier = $resolved['tier'] ?? 'standard';

        // Filter tools based on model tier
        add_filter('gds-assistant/tools', fn (array $tools) => ToolRestrictor::filter($tools, $modelTier));

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

        // Check for tool approval/denial response
        $approval = $this->detectToolApproval($request->get_param('messages'));
        if ($approval) {
            [$toolUseId, $approved] = $approval;
            // Remove the approval message from the conversation (it's a control message)
            array_pop($messages);
            $messages = $this->handleToolApproval(
                $messages, $toolUseId, $approved,
                fn (string $type, array $data) => $this->sendSSE($type, $data),
            );
        } else {
            // User sent a regular message (not an approval click). If the
            // conversation still has pending_approval stubs — e.g. from an
            // earlier turn where the Approve UI was dismissed without being
            // clicked — re-emit the approval_required events so the buttons
            // come back. We do NOT alter message content here: the LLM will
            // see the pending state and can respond ("please click Approve")
            // while the UI simultaneously surfaces the buttons.
            $this->resurfacePendingApprovals(
                $messages,
                fn (string $type, array $data) => $this->sendSSE($type, $data),
            );
        }

        // Allow filter to override the provider
        $provider = apply_filters('gds-assistant/provider', $provider);

        // Build tool registry
        $toolRegistry = new ToolRegistry;
        do_action('gds-assistant/register_tools', $toolRegistry);

        // Run the agentic loop with audit logging
        $auditLog = new AuditLog;
        $existingSummary = $conversation['summary'] ?? '';
        $loop = new MessageLoop(
            $provider,
            $toolRegistry,
            $auditLog,
            $conversationId,
            $userId,
            $existingSummary,
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

            // Update rolling summary — either from compression or incremental turn
            $newSummary = $loop->getUpdatedSummary();
            if ($newSummary) {
                $updateData['summary'] = $newSummary;
            } else {
                // Append a turn summary to the rolling summary
                $newMessages = array_slice($updatedMessages, count($messages) - count($request->get_param('messages')));
                $turnSummary = ContextCompressor::buildTurnSummary($newMessages);
                if ($turnSummary) {
                    $current = $existingSummary;
                    $updateData['summary'] = $current
                        ? $current."\n".$turnSummary
                        : $turnSummary;
                }
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

    private const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB base64

    private const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

    private function normalizeMessages(array $messages): array
    {
        return array_map(function ($msg) {
            $role = $msg['role'] ?? 'user';
            $content = $msg['content'] ?? '';

            if (is_string($content)) {
                return ['role' => $role, 'content' => $content];
            }

            // Validate and filter image content blocks
            if (is_array($content)) {
                $content = array_values(array_filter($content, function ($block) {
                    if (($block['type'] ?? '') !== 'image') {
                        return true;
                    }

                    $source = $block['source'] ?? [];
                    $sourceType = $source['type'] ?? '';

                    // URL-type images: validate it's a real URL on our domain
                    if ($sourceType === 'url') {
                        $url = $source['url'] ?? '';
                        if (! filter_var($url, FILTER_VALIDATE_URL)) {
                            return false;
                        }
                        // Only allow same-origin or https URLs
                        $siteHost = parse_url(home_url(), PHP_URL_HOST);
                        $imageHost = parse_url($url, PHP_URL_HOST);
                        if ($imageHost !== $siteHost && ! str_starts_with($url, 'https://')) {
                            return false;
                        }

                        return true;
                    }

                    // Base64-type images: validate media type and size
                    $mediaType = $source['media_type'] ?? '';
                    $data = $source['data'] ?? '';

                    if (! in_array($mediaType, self::ALLOWED_IMAGE_TYPES, true)) {
                        return false;
                    }

                    if (strlen($data) > self::MAX_IMAGE_SIZE) {
                        return false;
                    }

                    return true;
                }));
            }

            return ['role' => $role, 'content' => $content];
        }, $messages);
    }

    /**
     * Check if the incoming messages contain a tool approval/denial response.
     * Returns [toolUseId, approved] or null.
     */
    private function detectToolApproval(array $messages): ?array
    {
        if (empty($messages)) {
            return null;
        }

        $lastMsg = end($messages);
        $content = $lastMsg['content'] ?? '';
        if (! is_string($content)) {
            return null;
        }

        if (str_starts_with($content, '__tool_approved__:')) {
            return [substr($content, strlen('__tool_approved__:')), true];
        }
        if (str_starts_with($content, '__tool_denied__:')) {
            return [substr($content, strlen('__tool_denied__:')), false];
        }

        return null;
    }

    /**
     * Handle tool approval: when a single tool_use_id is provided, approve or
     * deny only that one — BUT also batch-approve/deny any sibling pending
     * tool_results that came from the same assistant message, because the UI
     * only surfaces one Approve/Deny button per turn and the user expects
     * their one click to cover all prompts they saw.
     */
    private function handleToolApproval(
        array $storedMessages,
        string $toolUseId,
        bool $approved,
        callable $onEvent,
    ): array {
        $toolRegistry = new ToolRegistry;
        do_action('gds-assistant/register_tools', $toolRegistry);

        // Collect all (tool_use_id → [name, input]) pairs that currently have
        // a pending_approval tool_result.
        $pending = [];
        foreach ($storedMessages as $msg) {
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }
            // assistant tool_use blocks → name + input
            if (($msg['role'] ?? '') === 'assistant') {
                foreach ($msg['content'] as $block) {
                    if (is_array($block) && ($block['type'] ?? '') === 'tool_use') {
                        $pending[$block['id']] = [
                            'name' => $block['name'],
                            'input' => json_decode(json_encode($block['input'] ?? []), true) ?: [],
                            'is_pending' => false,
                        ];
                    }
                }
            }
            // user tool_result blocks → flag which ones are still pending
            if (($msg['role'] ?? '') === 'user') {
                foreach ($msg['content'] as $block) {
                    if (is_array($block) && ($block['type'] ?? '') === 'tool_result') {
                        $id = $block['tool_use_id'] ?? '';
                        if (! $id || ! isset($pending[$id])) {
                            continue;
                        }
                        $content = is_string($block['content'] ?? null) ? $block['content'] : '';
                        $decoded = json_decode($content, true);
                        if (is_array($decoded) && ($decoded['status'] ?? '') === 'pending_approval') {
                            $pending[$id]['is_pending'] = true;
                        }
                    }
                }
            }
        }

        $pendingIds = array_keys(array_filter($pending, fn ($p) => $p['is_pending']));

        // If the client referenced a tool that we can't find at all (stale
        // client state, e.g. after a manual DB edit), emit a single denial
        // event for it so the approval UI can clear. Otherwise fall through
        // to the normal batch-resolution path.
        if (! $pendingIds && ! isset($pending[$toolUseId])) {
            $onEvent('tool_result', [
                'tool_use_id' => $toolUseId,
                'result' => ['error' => 'User denied this action'],
                'is_error' => true,
            ]);

            return $storedMessages;
        }

        // Make sure the explicitly-requested tool is among the pending set; if
        // not, prepend it so a focused approval still fires.
        if (isset($pending[$toolUseId]) && ! in_array($toolUseId, $pendingIds, true)) {
            $pendingIds[] = $toolUseId;
        }

        $newResults = [];
        foreach ($pendingIds as $id) {
            $info = $pending[$id] ?? null;
            if ($approved && $info && ! empty($info['name'])) {
                $result = $toolRegistry->executeTool($info['name'], $info['input']);
                $isError = is_wp_error($result);
                $resultContent = $isError ? ['error' => $result->get_error_message()] : $result;
            } else {
                $isError = true;
                $resultContent = ['error' => 'User denied this action'];
            }

            $onEvent('tool_result', [
                'tool_use_id' => $id,
                'result' => $resultContent,
                'is_error' => $isError,
            ]);

            $newResults[$id] = [
                'content' => json_encode($resultContent),
                'is_error' => $isError,
            ];
        }

        // Replace the pending_approval tool_result in stored messages for
        // every ID we just resolved.
        foreach ($storedMessages as &$msg) {
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }
            foreach ($msg['content'] as &$block) {
                if (! is_array($block) || ($block['type'] ?? '') !== 'tool_result') {
                    continue;
                }
                $id = $block['tool_use_id'] ?? '';
                if (isset($newResults[$id])) {
                    $block['content'] = $newResults[$id]['content'];
                    $block['is_error'] = $newResults[$id]['is_error'];
                }
            }
        }

        return $storedMessages;
    }

    /**
     * Re-emit tool_approval_required events for every pending_approval
     * tool_result still in the conversation. Called on each regular user
     * message so the Approve/Deny UI comes back if it was dismissed (tab
     * reload, new message typed, etc.). The LLM still sees the actual
     * pending state and can narrate it; this call just makes sure the user
     * has functional buttons to resolve it.
     */
    private function resurfacePendingApprovals(array $messages, callable $onEvent): void
    {
        $toolInfo = [];
        $pendingIds = [];

        foreach ($messages as $msg) {
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }
            if (($msg['role'] ?? '') === 'assistant') {
                foreach ($msg['content'] as $block) {
                    if (is_array($block) && ($block['type'] ?? '') === 'tool_use' && ! empty($block['id'])) {
                        $toolInfo[$block['id']] = [
                            'name' => $block['name'] ?? '',
                            'input' => json_decode(json_encode($block['input'] ?? []), true) ?: [],
                        ];
                    }
                }
            }
            if (($msg['role'] ?? '') === 'user') {
                foreach ($msg['content'] as $block) {
                    if (! is_array($block) || ($block['type'] ?? '') !== 'tool_result') {
                        continue;
                    }
                    $id = $block['tool_use_id'] ?? '';
                    $content = is_string($block['content'] ?? null) ? $block['content'] : '';
                    $decoded = json_decode($content, true);
                    if (is_array($decoded) && ($decoded['status'] ?? '') === 'pending_approval' && isset($toolInfo[$id])) {
                        $pendingIds[] = $id;
                    }
                }
            }
        }

        foreach ($pendingIds as $id) {
            $info = $toolInfo[$id];
            $abilityName = AbilitiesToolProvider::toAbilityName($info['name']);
            $onEvent('tool_approval_required', [
                'tool_use_id' => $id,
                'tool_name' => $abilityName,
                'input' => $info['input'],
            ]);
        }
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
        $messages = array_map(function (array $msg) {
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

        return self::patchDanglingToolUses($messages);
    }

    /**
     * Defensive fix for corrupted conversation history: every tool_use block
     * must have a matching tool_result block in the IMMEDIATELY NEXT user
     * message, otherwise Anthropic rejects the request with:
     *
     *   "tool_use ids were found without tool_result blocks immediately after"
     *
     * This can happen when:
     *   - An earlier version of MessageLoop broke out of a tool-execution
     *     foreach when a dangerous tool hit approval, skipping remaining
     *     tool_uses in the same assistant message (fixed, but old history
     *     may still be malformed)
     *   - A mid-turn exception killed the request between pushing the
     *     assistant message and pushing the tool_results user message
     *
     * For any tool_use that has no paired tool_result, inject a synthetic
     * "skipped" tool_result so the conversation replays cleanly.
     */
    private static function patchDanglingToolUses(array $messages): array
    {
        $count = count($messages);
        $result = [];

        for ($i = 0; $i < $count; $i++) {
            $msg = $messages[$i];
            $result[] = $msg;

            if (($msg['role'] ?? '') !== 'assistant' || ! is_array($msg['content'] ?? null)) {
                continue;
            }

            $toolUseIds = [];
            foreach ($msg['content'] as $block) {
                if (is_array($block) && ($block['type'] ?? '') === 'tool_use' && ! empty($block['id'])) {
                    $toolUseIds[] = $block['id'];
                }
            }
            if (! $toolUseIds) {
                continue;
            }

            $next = $messages[$i + 1] ?? null;
            $nextIsUser = is_array($next) && ($next['role'] ?? '') === 'user' && is_array($next['content'] ?? null);

            $seenIds = [];
            if ($nextIsUser) {
                foreach ($next['content'] as $block) {
                    if (is_array($block) && ($block['type'] ?? '') === 'tool_result' && ! empty($block['tool_use_id'])) {
                        $seenIds[] = $block['tool_use_id'];
                    }
                }
            }

            $missing = array_values(array_diff($toolUseIds, $seenIds));
            if (! $missing) {
                continue;
            }

            $patches = array_map(fn ($id) => [
                'type' => 'tool_result',
                'tool_use_id' => $id,
                'content' => json_encode(['error' => 'skipped — tool was not paired with a result in the stored conversation']),
                'is_error' => true,
            ], $missing);

            if ($nextIsUser) {
                // Merge patches into the existing next user message when we
                // reach it on the next iteration. Mutate the source array so
                // the next push sees the patched content.
                $messages[$i + 1]['content'] = array_merge($next['content'], $patches);
            } else {
                // No next user message at all — inject one right after this
                // assistant message.
                $result[] = ['role' => 'user', 'content' => $patches];
            }
        }

        return $result;
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
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
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
