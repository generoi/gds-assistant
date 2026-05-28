<?php

namespace GeneroWP\Assistant\Api;

use GeneroWP\Assistant\Bridge\AbilitiesToolProvider;
use GeneroWP\Assistant\Bridge\DestructiveGuard;
use GeneroWP\Assistant\Bridge\EditorToolProvider;
use GeneroWP\Assistant\Bridge\ToolRegistry;
use GeneroWP\Assistant\Bridge\ToolRestrictor;
use GeneroWP\Assistant\Llm\AiSupport;
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
                'editor_context' => [
                    'type' => 'object',
                    'default' => null,
                    'description' => 'Live block-editor state: presence + a lightweight selection summary. Enables the editor_* client tools.',
                ],
                'client_tool_results' => [
                    'type' => 'array',
                    'default' => null,
                    'description' => 'Results of client-executed editor tools, posted back to resume the loop: [{tool_use_id, result, is_error}].',
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
        if (! AiSupport::isEnabled()) {
            return new WP_REST_Response([
                'error' => AiSupport::unavailableMessage(),
            ], 403);
        }

        if (! ProviderRegistry::hasAnyProvider()) {
            return new WP_REST_Response([
                'error' => 'No AI provider configured. Configure a WordPress connector or set a provider API key in the environment.',
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

        // Daily token budget — backstop against runaway cost.
        $budgetCheck = TokenBudget::check($userId);
        if (is_wp_error($budgetCheck)) {
            return new WP_REST_Response([
                'error' => $budgetCheck->get_error_message(),
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
                // Recover from stranded client tool calls: if a previous turn
                // emitted a `tool_use` (e.g. an editor write tool) whose
                // approval Promise never resolved — page refresh mid-decision,
                // CDP timeout in a test, etc. — Anthropic would reject the
                // next request because every tool_use needs a matching
                // tool_result. Inject a synthetic "cancelled" result so the
                // conversation can continue instead of silently failing.
                $storedMessages = self::patchOrphanToolUses($storedMessages);
                // Heal "mixed" user messages saved by the old merge logic
                // (tool_result blocks combined with plain text in one bag) —
                // split them back into a tool-result message followed by a
                // text message so the OpenAI converter doesn't silently drop
                // the text.
                $storedMessages = self::splitMixedUserMessages($storedMessages);
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

        // Resume after browser-executed editor tools: splice each client result
        // into its pending_client stub, then let the loop continue.
        $clientResults = $request->get_param('client_tool_results');
        $approval = $this->detectToolApproval($request->get_param('messages'));
        if (is_array($clientResults) && $clientResults) {
            array_pop($messages); // remove the control message
            $messages = $this->handleClientToolResults(
                $messages, $clientResults,
                fn (string $type, array $data) => $this->sendSSE($type, $data),
                $conversationId, $userId,
            );
        } elseif ($approval) {
            [$toolUseId, $approved] = $approval;
            // Remove the approval message from the conversation (it's a control message)
            array_pop($messages);
            $messages = $this->handleToolApproval(
                $messages, $toolUseId, $approved,
                fn (string $type, array $data) => $this->sendSSE($type, $data),
                $conversationId, $userId,
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

            // Append per-conversation info AFTER the cached base prompt so
            // skills (like /report-bug) can reference them. Kept short to
            // minimize cache-miss cost.
            $systemPrompt .= "\n\n## This conversation\n";
            $systemPrompt .= "- Conversation ID: {$conversationId}\n";
            $systemPrompt .= '- Site admin email: '.get_bloginfo('admin_email')."\n";

            $systemContext = trim($request->get_param('system_context') ?? '');
            if ($systemContext) {
                $systemPrompt .= "\n\nUser context for this chat:\n".$systemContext;
            }

            // When the user has the block editor open, expose the editor_*
            // client tools and tell the model to prefer them over server-side
            // content edits (which would fight the unsaved document).
            $editorContext = $request->get_param('editor_context');
            if (is_array($editorContext) && ! empty($editorContext['has_editor'])) {
                add_filter('gds-assistant/tools', [$this, 'addEditorTools']);
                $systemPrompt .= $this->editorContextPrompt($editorContext);
            }

            self::log('info', 'Chat request', [
                'conversation' => $conversationId,
                'user' => $userId,
                'model' => $modelId,
                'provider' => $provider->name(),
                'new_messages' => count($request->get_param('messages')),
                'total_messages' => count($messages),
            ]);

            // When the user typed into the chat with something selected in the
            // editor, the client attaches a selection snapshot on the editor
            // context. Prepend a short summary to the latest user message body
            // so the model has the snippet inline (avoids an
            // `editor__read_selection` round-trip on common "rewrite this" /
            // "translate these" prompts). Done here instead of in the system
            // prompt to keep the prompt cache stable across selection changes.
            // Skip when resuming a tool / approval flow: those branches
            // popped the trailing control message above, so there's no fresh
            // user message to annotate.
            if (
                is_array($editorContext)
                && ! empty($editorContext['has_editor'])
                && ! is_array($clientResults)
                && ! $approval
            ) {
                $preamble = $this->buildSelectionPreamble($editorContext);
                if ($preamble !== '') {
                    $messages = $this->prependToLatestUser($messages, $preamble);
                }
            }

            // Collapse any consecutive same-role messages (e.g. an undo note
            // appended out-of-band by the Undo button) so the provider sees
            // valid alternating roles. No-op for normal alternating histories.
            $messages = self::mergeConsecutiveRoles($messages);

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

            // Count this request's tokens against the user's daily budget.
            TokenBudget::record($userId, $loop->getInputTokens() + $loop->getOutputTokens());

            // Persist conversation (only set title on first save)
            // Stamp a per-message timestamp (epoch ms) on anything that doesn't
            // carry one yet, so timestamps persist with the conversation and
            // show on reload. Loaded messages keep their original `ts`; only the
            // turn's new messages get "now". The provider never sees `ts`
            // (MessageLoop strips it from its payload copy).
            $nowMs = (int) round(microtime(true) * 1000);
            $updatedMessages = array_map(function ($m) use ($nowMs) {
                if (! isset($m['ts'])) {
                    $m['ts'] = $nowMs;
                }

                return $m;
            }, $updatedMessages);

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

    /**
     * Collapse consecutive same-role messages into one (combining content into
     * blocks). Anthropic requires alternating roles; an out-of-band note such
     * as the Undo button's "↩ Reverted…" user message can otherwise leave two
     * user messages in a row. Semantically equivalent for the provider.
     *
     * One exception: a user message that carries a `tool_result` is treated
     * as a different "kind" from a plain-text user message and won't merge
     * with one. They look identical at the storage layer (both `role: user`)
     * but the OpenAI converter splits them into `role: tool` vs `role: user`
     * downstream — merging the two would smuggle plain text into a tool
     * message and the converter silently drops it, leaving the model with
     * "here is your tool result" and no actual user question to answer.
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @return array<int, array<string, mixed>>
     */
    private static function mergeConsecutiveRoles(array $messages): array
    {
        $out = [];
        foreach ($messages as $msg) {
            $i = count($out) - 1;
            $sameRole = $i >= 0 && ($out[$i]['role'] ?? null) === ($msg['role'] ?? null);
            $compatible = $sameRole && self::userKind($out[$i]) === self::userKind($msg);
            if ($sameRole && $compatible) {
                $out[$i]['content'] = array_merge(
                    self::asContentBlocks($out[$i]['content'] ?? ''),
                    self::asContentBlocks($msg['content'] ?? ''),
                );
            } else {
                $out[] = $msg;
            }
        }

        return $out;
    }

    /**
     * For user messages, distinguish "tool-result-bearing" from "plain text"
     * and from already-mixed (legacy) so they don't merge together. Anything
     * other than role=user falls through to a single bucket — assistant
     * messages are merged by role alone like before.
     */
    private static function userKind(array $msg): string
    {
        if (($msg['role'] ?? null) !== 'user') {
            return 'other';
        }
        $content = $msg['content'] ?? '';
        if (is_string($content)) {
            return 'text';
        }
        if (! is_array($content)) {
            return 'text';
        }
        $hasToolResult = false;
        $hasOther = false;
        foreach ($content as $part) {
            if (is_array($part) && ($part['type'] ?? null) === 'tool_result') {
                $hasToolResult = true;
            } elseif (is_array($part) || is_string($part)) {
                $hasOther = true;
            }
        }
        if ($hasToolResult && $hasOther) {
            return 'mixed';
        }
        if ($hasToolResult) {
            return 'tool_result';
        }

        return 'text';
    }

    /**
     * Split any user message that already carries BOTH a tool_result and
     * plain text/image content into two separate user messages — the tool
     * result first, then the rest. We only re-emit if there's at least one
     * tool_result AND at least one non-tool_result part; clean messages pass
     * through unchanged.
     *
     * This heals conversations that were already saved in the mixed shape
     * by the old `mergeConsecutiveRoles` (which would combine a tool_result
     * with subsequent text into a single bag, after which the OpenAI
     * converter silently dropped the text).
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @return array<int, array<string, mixed>>
     */
    private static function splitMixedUserMessages(array $messages): array
    {
        $out = [];
        foreach ($messages as $msg) {
            if (self::userKind($msg) !== 'mixed') {
                $out[] = $msg;

                continue;
            }
            $toolResults = [];
            $rest = [];
            foreach ((array) ($msg['content'] ?? []) as $part) {
                if (is_array($part) && ($part['type'] ?? null) === 'tool_result') {
                    $toolResults[] = $part;
                } else {
                    $rest[] = $part;
                }
            }
            $base = $msg;
            unset($base['content']);
            if ($toolResults) {
                $out[] = $base + ['content' => $toolResults];
            }
            if ($rest) {
                $out[] = $base + ['content' => $rest];
            }
        }

        return $out;
    }

    /**
     * Build the short "[The user has selected …]" preamble for the latest
     * user message, based on the editor-context selection snapshot. Returns
     * '' when there's nothing meaningful to attach (empty selection / unknown
     * shape).
     *
     * @param  array<string, mixed>  $ctx  editor_context payload
     */
    private function buildSelectionPreamble(array $ctx): string
    {
        $mode = $ctx['selection_mode'] ?? null;

        if ($mode === 'text-range' && ! empty($ctx['selected_text'])) {
            $label = (string) ($ctx['selected_block_label'] ?? 'block');
            $idHint = ! empty($ctx['selected_block_client_id'])
                ? ' (block '.$ctx['selected_block_client_id'].')'
                : '';

            return '[The user has highlighted text in the '.$label.$idHint.': "'
                .$ctx['selected_text'].'"]'."\n\n";
        }

        if ($mode === 'whole-block' && ! empty($ctx['selected_block_label'])) {
            $label = (string) $ctx['selected_block_label'];
            $idHint = ! empty($ctx['selected_block_client_id'])
                ? ' (block '.$ctx['selected_block_client_id'].')'
                : '';
            $text = (string) ($ctx['selected_block_text'] ?? '');
            if ($text !== '') {
                return '[The user has selected the '.$label.$idHint.': "'.$text.'"]'."\n\n";
            }

            // Non-text block (image / gallery / etc.) — just announce it.
            return '[The user has selected a '.$label.' block'.$idHint.']'."\n\n";
        }

        if ($mode === 'multi-block') {
            $count = (int) ($ctx['selected_block_count'] ?? 0);
            $labels = is_array($ctx['selected_block_labels'] ?? null)
                ? array_values(array_filter($ctx['selected_block_labels'], 'is_string'))
                : [];
            $list = $labels ? ': '.implode(', ', array_slice($labels, 0, 10)) : '';

            return '[The user has selected '.$count.' blocks'.$list.']'."\n\n";
        }

        return '';
    }

    /**
     * Prepend a short preamble to the latest user message's content, so the
     * model sees the user's editor selection inline with what they typed.
     * Lives inside the user message (not the system prompt) so it doesn't
     * invalidate the prompt cache as the selection changes turn to turn.
     *
     * Handles both content shapes the client may send:
     *   - string content → prepend to the string
     *   - array of content blocks → prepend a leading text block (or merge
     *     into an existing leading text block)
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @return array<int, array<string, mixed>>
     */
    private function prependToLatestUser(array $messages, string $preamble): array
    {
        // Find the LAST user message (the one we just received).
        $idx = -1;
        for ($i = count($messages) - 1; $i >= 0; $i--) {
            if (($messages[$i]['role'] ?? null) === 'user') {
                $idx = $i;
                break;
            }
        }
        if ($idx < 0) {
            return $messages;
        }

        $content = $messages[$idx]['content'] ?? '';

        if (is_string($content)) {
            $messages[$idx]['content'] = $preamble.$content;

            return $messages;
        }

        if (is_array($content)) {
            $blocks = array_values($content);
            // Merge into a leading text block if there is one so we don't
            // bloat the content-blocks array unnecessarily.
            if (! empty($blocks) && ($blocks[0]['type'] ?? null) === 'text') {
                $blocks[0]['text'] = $preamble.($blocks[0]['text'] ?? '');
            } else {
                array_unshift($blocks, ['type' => 'text', 'text' => $preamble]);
            }
            $messages[$idx]['content'] = $blocks;
        }

        return $messages;
    }

    /**
     * Walk loaded conversation history and inject a synthetic tool_result for
     * any tool_use that doesn't have a matching tool_result downstream.
     *
     * This recovers from "the editor approval was never decided" scenarios:
     * a tool_use lands in history, the matching tool_result never arrives
     * (page refresh during the diff card, browser tab crash, etc.), and
     * Anthropic rejects every subsequent /chat call with "tool_use without
     * corresponding tool_result". The injected result is a regular user
     * message with a tool_result block declaring the call cancelled, so the
     * model can move on instead of the conversation getting permanently
     * stuck.
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @return array<int, array<string, mixed>>
     */
    private static function patchOrphanToolUses(array $messages): array
    {
        // First pass: collect every tool_use_id that already has a tool_result.
        $resolved = [];
        foreach ($messages as $msg) {
            if (($msg['role'] ?? null) !== 'user') {
                continue;
            }
            $content = $msg['content'] ?? [];
            if (! is_array($content)) {
                continue;
            }
            foreach ($content as $part) {
                if (is_array($part) && ($part['type'] ?? null) === 'tool_result') {
                    $id = $part['tool_use_id'] ?? null;
                    if (is_string($id) && $id !== '') {
                        $resolved[$id] = true;
                    }
                }
            }
        }

        // Second pass: for any assistant tool_use whose id isn't in $resolved,
        // splice a synthetic cancellation result immediately after.
        $out = [];
        foreach ($messages as $msg) {
            $out[] = $msg;
            if (($msg['role'] ?? null) !== 'assistant') {
                continue;
            }
            $content = $msg['content'] ?? [];
            if (! is_array($content)) {
                continue;
            }
            $orphanResults = [];
            foreach ($content as $part) {
                if (! is_array($part) || ($part['type'] ?? null) !== 'tool_use') {
                    continue;
                }
                $id = $part['id'] ?? null;
                if (! is_string($id) || $id === '' || isset($resolved[$id])) {
                    continue;
                }
                $orphanResults[] = [
                    'type' => 'tool_result',
                    'tool_use_id' => $id,
                    'content' => 'Edit cancelled — the user closed the chat before deciding.',
                    'is_error' => true,
                ];
                $resolved[$id] = true; // don't double-patch
            }
            if ($orphanResults) {
                $out[] = ['role' => 'user', 'content' => $orphanResults];
            }
        }

        return $out;
    }

    /**
     * Normalize message content to an array of content blocks.
     *
     * @return array<int, mixed>
     */
    private static function asContentBlocks(mixed $content): array
    {
        if (is_string($content)) {
            return $content === '' ? [] : [['type' => 'text', 'text' => $content]];
        }

        return is_array($content) ? array_values($content) : [];
    }

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
            $rest = substr($content, strlen('__tool_approved__:'));
            // Optional "|trust:host" suffix signals trust-on-approval.
            $parts = explode('|trust:', $rest, 2);
            $toolUseId = $parts[0];
            $trustHost = $parts[1] ?? '';
            if ($trustHost !== '') {
                do_action('gds-assistant/approve_with_trust', $trustHost);
            }

            return [$toolUseId, true];
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
        string $conversationUuid = '',
        int $userId = 0,
    ): array {
        $toolRegistry = new ToolRegistry;
        do_action('gds-assistant/register_tools', $toolRegistry);
        $auditLog = new AuditLog;

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
            $undoState = null;
            if ($approved && $info && ! empty($info['name'])) {
                // The user just approved this action — pass the human
                // confirmation downstream so abilities with a data-layer
                // destructive guard (e.g. gds/forms-update) allow it through.
                $input = DestructiveGuard::injectConfirmation($info['name'], $info['input']);
                $result = $toolRegistry->executeTool($info['name'], $input);
                $isError = is_wp_error($result);

                // Peel the `_undo` snapshot off before it reaches the LLM/UI.
                if (! $isError && is_array($result) && isset($result['_undo'])) {
                    $undoState = $result['_undo'];
                    unset($result['_undo']);
                }

                $resultContent = $isError ? ['error' => $result->get_error_message()] : $result;
            } else {
                $isError = true;
                $resultContent = ['error' => 'User denied this action'];
            }

            // Record the decision. Approved executions run here (not in
            // MessageLoop), so without this the most sensitive — gated,
            // destructive — actions would never reach the audit log. Denials
            // are logged too, so a blocked attempt leaves a trace.
            $logged = ['id' => 0, 'undoable' => false];
            if ($info && ! empty($info['name'])) {
                $logged = $auditLog->log(
                    $conversationUuid,
                    $userId,
                    AbilitiesToolProvider::toAbilityName($info['name']),
                    $info['input'] ?? [],
                    $approved ? $resultContent : ['decision' => 'denied'],
                    $isError,
                    true, // approval is only required for destructive/gated tools
                    $undoState,
                );
            }

            $resultEvent = [
                'tool_use_id' => $id,
                'result' => $resultContent,
                'is_error' => $isError,
            ];
            if ($logged['undoable'] && $logged['id']) {
                $resultEvent['undoable'] = true;
                $resultEvent['audit_id'] = $logged['id'];
                $resultEvent['undo_label'] = $undoState['label'] ?? 'Undo this action';
            }
            $onEvent('tool_result', $resultEvent);

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

    /** Append the editor_* client tools (filter on `gds-assistant/tools`). */
    public function addEditorTools(array $tools): array
    {
        return array_merge($tools, (new EditorToolProvider)->getTools());
    }

    /** Short system-prompt guidance + a summary of the user's editor selection. */
    private function editorContextPrompt(array $ctx): string
    {
        $out = "\n\n## Open block editor\n";
        $out .= "The user has the block editor open. Edit THIS document with the `editor_*` tools (live + undoable), not `gds/blocks-patch`/`gds/content-update` — those edit the saved copy and are lost on save.\n";
        $out .= "Read the selection/outline before editing; clientIds change after each edit, so re-read before the next. Set the post title with `editor__update_post`. Use valid Gutenberg markup (`gds/block-types-list`/`gds/blocks-get`).\n";
        $out .= 'Colors: a palette slug from `gds/design-theme-json` (e.g. `ui-01`) as `textColor`/`backgroundColor` or `var:preset|color|{slug}`, not hex or display names.';
        $out .= array_key_exists('custom_colors', $ctx) && ! $ctx['custom_colors']
            ? " Custom hex is disabled here.\n"
            : "\n";

        // The volatile selection snapshot (which blocks are selected) is
        // deliberately NOT included here: it would change this system block on
        // every selection change and invalidate the prompt cache for the whole
        // system + tools prefix. `editor__read_selection` returns the live
        // selection AND post context, and the guidance above already says to
        // read before editing — so the model gets it without churning the cache.
        if (! empty($ctx['post_id'])) {
            $type = preg_replace('/[^a-z0-9_-]/i', '', (string) ($ctx['post_type'] ?? 'post'));
            $out .= 'Editing post #'.(int) $ctx['post_id'].' ('.$type.'). Call `editor__read_selection` for the current selection and document state.'."\n";
        }

        return $out;
    }

    /**
     * Resume after browser-executed editor tools. For each result: splice it
     * into the matching pending_client stub, emit a tool_result so the UI
     * updates, and audit the edit. No server execution — the browser already
     * applied it.
     *
     * @param  array<int, array<string, mixed>>  $storedMessages
     * @param  array<int, array<string, mixed>>  $clientResults  [{tool_use_id, result, is_error}]
     * @return array<int, array<string, mixed>>
     */
    private function handleClientToolResults(
        array $storedMessages,
        array $clientResults,
        callable $onEvent,
        string $conversationUuid = '',
        int $userId = 0,
    ): array {
        // Map originating tool_use blocks (id → name + input) for audit.
        $toolUses = [];
        foreach ($storedMessages as $msg) {
            if (($msg['role'] ?? '') !== 'assistant' || ! is_array($msg['content'] ?? null)) {
                continue;
            }
            foreach ($msg['content'] as $block) {
                if (is_array($block) && ($block['type'] ?? '') === 'tool_use') {
                    $toolUses[$block['id'] ?? ''] = [
                        'name' => (string) ($block['name'] ?? ''),
                        'input' => json_decode(json_encode($block['input'] ?? []), true) ?: [],
                    ];
                }
            }
        }

        $resolved = [];
        $auditLog = new AuditLog;
        foreach ($clientResults as $clientResult) {
            if (! is_array($clientResult)) {
                continue;
            }
            $toolUseId = (string) ($clientResult['tool_use_id'] ?? '');
            if ($toolUseId === '') {
                continue;
            }
            $isError = ! empty($clientResult['is_error']);
            $resultContent = $clientResult['result']
                ?? ($isError ? ['error' => 'Editor tool failed'] : ['ok' => true]);

            // Audit the live edit (not undoable here — Cmd/Ctrl+Z handles undo).
            $auditLog->log(
                $conversationUuid,
                $userId,
                $toolUses[$toolUseId]['name'] ?? 'editor',
                $toolUses[$toolUseId]['input'] ?? [],
                $resultContent,
                $isError,
            );

            $onEvent('tool_result', [
                'tool_use_id' => $toolUseId,
                'result' => $resultContent,
                'is_error' => $isError,
            ]);

            $resolved[$toolUseId] = [
                'content' => json_encode($resultContent),
                'is_error' => $isError,
            ];
        }

        // Splice resolved results into their pending_client stubs.
        foreach ($storedMessages as &$msg) {
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }
            foreach ($msg['content'] as &$block) {
                if (! is_array($block) || ($block['type'] ?? '') !== 'tool_result') {
                    continue;
                }
                $id = $block['tool_use_id'] ?? '';
                if (isset($resolved[$id])) {
                    $block['content'] = $resolved[$id]['content'];
                    $block['is_error'] = $resolved[$id]['is_error'];
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
                // Strip provider-specific metadata that other providers reject
                unset($block['_thought_signature']);

                return $block;
            }, $msg['content']);

            return $msg;
        }, $messages);

        // Order matters:
        //   1. Drop any empty user/assistant messages first, so we don't
        //      treat an empty user message as "the paired tool_result
        //      message" for an assistant tool_use.
        //   2. Then patch dangling tool_uses — any now-unpaired tool_use
        //      gets a synthetic skipped-result user message injected.
        $messages = self::stripServerToolBlocks($messages);
        $messages = self::stripEmptyTextBlocks($messages);
        $messages = self::dropEmptyContentMessages($messages);
        $messages = self::patchDanglingToolUses($messages);

        return $messages;
    }

    /**
     * Drop messages whose content is empty — Anthropic rejects with
     * "user messages must have non-empty content". Can happen when older
     * control messages were stored, or when a block array ended up empty
     * after sanitization, or from other legacy buggy states.
     */
    private static function dropEmptyContentMessages(array $messages): array
    {
        return array_values(array_filter($messages, function ($msg) {
            $content = $msg['content'] ?? null;
            if (is_string($content)) {
                return trim($content) !== '';
            }
            if (is_array($content)) {
                // Keep if at least one block has something meaningful
                foreach ($content as $block) {
                    if (! is_array($block)) {
                        if (! empty($block)) {
                            return true;
                        }

                        continue;
                    }
                    $type = $block['type'] ?? '';
                    if ($type === 'text' && ! empty(trim((string) ($block['text'] ?? '')))) {
                        return true;
                    }
                    if (in_array($type, ['tool_use', 'tool_result', 'image', 'server_tool_use', 'web_search_tool_result'], true)) {
                        return true;
                    }
                }

                return false;
            }

            return false;
        }));
    }

    /**
     * Strip Anthropic server-tool blocks (web_search, code_execution, etc.)
     * from stored history. These are ephemeral server-side tools whose
     * names are validated strictly — replaying them after context compression
     * or provider switches causes 400 errors.
     */
    private static function stripServerToolBlocks(array $messages): array
    {
        $serverTypes = ['server_tool_use', 'web_search_tool_result', 'advisor_tool_use', 'advisor_tool_result'];

        return array_map(function ($msg) use ($serverTypes) {
            $content = $msg['content'] ?? null;
            if (! is_array($content)) {
                return $msg;
            }

            $msg['content'] = array_values(array_filter($content, function ($block) use ($serverTypes) {
                if (! is_array($block)) {
                    return true;
                }

                return ! in_array($block['type'] ?? '', $serverTypes, true);
            }));

            return $msg;
        }, $messages);
    }

    /**
     * Strip empty text blocks from within messages. Anthropic rejects with
     * "text content blocks must be non-empty" when a message has an empty
     * text block alongside other valid blocks (e.g. tool_use). This can
     * happen when the LLM emits tool calls with an empty text prefix.
     */
    private static function stripEmptyTextBlocks(array $messages): array
    {
        return array_map(function ($msg) {
            $content = $msg['content'] ?? null;
            if (! is_array($content)) {
                return $msg;
            }

            $msg['content'] = array_values(array_filter($content, function ($block) {
                if (! is_array($block)) {
                    return true;
                }
                // Remove text blocks that are empty/whitespace-only
                if (($block['type'] ?? '') === 'text' && trim((string) ($block['text'] ?? '')) === '') {
                    return false;
                }

                return true;
            }));

            return $msg;
        }, $messages);
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

        if (headers_sent()) {
            return;
        }

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
