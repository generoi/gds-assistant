<?php

namespace GeneroWP\Assistant\Llm;

/**
 * Progressive context compression for long conversations.
 *
 * Level 1: Truncate large tool results to smart structured summaries (free)
 * Level 2: Strip old tool_result content, keep recent intact (free)
 * Level 3: Replace old messages with LLM-generated structured summary (1 cheap API call)
 *
 * Full conversation is always in the DB — LLM can re-fetch via tools.
 * Rolling summary persisted to DB for cross-request context continuity.
 */
class ContextCompressor
{
    private const CHARS_PER_TOKEN = 4;

    private const TOOL_RESULT_MAX_CHARS = 8000;

    private const LEVEL2_THRESHOLD = 50000;

    private const LEVEL3_THRESHOLD = 80000;

    private const KEEP_RECENT = 6;

    private const SUMMARY_PROMPT = <<<'PROMPT'
    Summarize this conversation for context continuity using these sections:

    ## What was done
    What the user asked for and what actions were taken.

    ## Key content
    IDs, titles, URLs, form IDs, page names, post types, taxonomies — anything that might be referenced later.

    ## Decisions made
    Choices, preferences, configurations established during the conversation.

    ## Current state
    What's the state of things right now — what's published, drafted, configured, broken.

    ## Pending tasks
    Anything mentioned but not yet done, or follow-ups discussed.

    Be thorough — this summary replaces the full conversation history. Include specific IDs and names, not just "some pages were edited".
    PROMPT;

    /**
     * Compress messages to fit within reasonable token limits.
     *
     * @param  array  $messages  Full conversation messages
     * @param  string  $existingSummary  Rolling summary from previous compressions
     * @return array{messages: array, summary: string} Compressed messages + updated summary
     */
    public static function compress(array $messages, string $existingSummary = ''): array
    {
        $thresholdL2 = apply_filters('gds-assistant/compression_threshold', self::LEVEL2_THRESHOLD);
        $thresholdL3 = apply_filters('gds-assistant/summary_threshold', self::LEVEL3_THRESHOLD);
        $keepRecent = apply_filters('gds-assistant/keep_recent_messages', self::KEEP_RECENT);

        $tokens = self::estimateTokens($messages);

        // Under threshold — no compression needed
        if ($tokens < $thresholdL2) {
            return ['messages' => $messages, 'summary' => $existingSummary];
        }

        // Level 1: Truncate large tool results with smart summaries
        $messages = self::truncateLargeToolResults($messages);
        $tokens = self::estimateTokens($messages);

        if ($tokens < $thresholdL2) {
            return ['messages' => $messages, 'summary' => $existingSummary];
        }

        // Strip old images before further compression
        $messages = self::stripOldImages($messages, $keepRecent);

        // Level 2: Strip old tool_result content
        $messages = self::stripOldToolResults($messages, $keepRecent);
        $tokens = self::estimateTokens($messages);

        if ($tokens < $thresholdL3) {
            return ['messages' => $messages, 'summary' => $existingSummary];
        }

        // Level 3: Summarize old messages
        $result = self::summarizeOldMessages($messages, $keepRecent, $existingSummary);

        return $result;
    }

    /**
     * Build a rolling summary update for the current turn.
     * Appended to the stored summary after each request.
     */
    public static function buildTurnSummary(array $newMessages): string
    {
        $parts = [];

        foreach ($newMessages as $msg) {
            $role = $msg['role'] ?? '';
            $content = $msg['content'] ?? '';

            if ($role === 'user') {
                $text = self::extractText($content);
                if ($text && ! str_starts_with($text, '[')) {
                    $parts[] = 'User asked: '.self::truncateText($text, 150);
                }
            } elseif ($role === 'assistant' && is_array($content)) {
                $toolNames = [];
                $responseText = '';
                foreach ($content as $block) {
                    if (($block['type'] ?? '') === 'tool_use') {
                        $toolNames[] = str_replace('__', '/', $block['name'] ?? '');
                    } elseif (($block['type'] ?? '') === 'text') {
                        $responseText .= $block['text'] ?? '';
                    }
                }
                if ($toolNames) {
                    $parts[] = 'Tools used: '.implode(', ', $toolNames);
                }
                if ($responseText) {
                    $parts[] = 'Result: '.self::truncateText(trim($responseText), 200);
                }
            }
        }

        return implode('. ', $parts);
    }

    /**
     * Generate an LLM-powered structured summary of old messages.
     * Uses the cheapest available model for the summary call.
     */
    public static function generateLlmSummary(array $oldMessages): ?string
    {
        // Build conversation text for the summarizer
        $conversationText = self::buildConversationText($oldMessages);

        // Use cheapest available provider
        $modelKey = self::getCheapestModel();
        if (! $modelKey) {
            return null; // No provider available, fall back to mechanical summary
        }

        $resolved = ProviderRegistry::resolve($modelKey, 4096);
        if (! $resolved) {
            return null;
        }

        $provider = $resolved['provider'];

        // Make a non-streaming summary call
        $summaryMessages = [
            ['role' => 'user', 'content' => "Here is a conversation to summarize:\n\n{$conversationText}"],
        ];

        $result = '';
        try {
            $blocks = $provider->stream(
                $summaryMessages,
                [], // no tools
                function (string $type, array $data) use (&$result) {
                    if ($type === 'text_delta') {
                        $result .= $data['text'] ?? '';
                    }
                },
                self::SUMMARY_PROMPT,
            );

            // Extract text from content blocks
            if (! $result) {
                foreach ($blocks as $block) {
                    if (($block['type'] ?? '') === 'text') {
                        $result .= $block['text'] ?? '';
                    }
                }
            }
        } catch (\Throwable $e) {
            error_log('[gds-assistant] LLM summary failed: '.$e->getMessage());

            return null;
        }

        return $result ?: null;
    }

    // ── Level 1: Smart tool result truncation ───────────────────

    private static function truncateLargeToolResults(array $messages): array
    {
        foreach ($messages as &$msg) {
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }

            foreach ($msg['content'] as &$block) {
                if (($block['type'] ?? '') !== 'tool_result') {
                    continue;
                }

                $content = $block['content'] ?? '';
                if (! is_string($content) || strlen($content) <= self::TOOL_RESULT_MAX_CHARS) {
                    continue;
                }

                $block['content'] = self::summarizeToolResult($content);
            }
        }

        return $messages;
    }

    // ── Level 2: Strip old tool results ─────────────────────────

    private static function stripOldToolResults(array $messages, int $keepRecent): array
    {
        $total = count($messages);
        $cutoff = max(0, $total - $keepRecent);

        for ($i = 0; $i < $cutoff; $i++) {
            $msg = &$messages[$i];

            if (! is_array($msg['content'] ?? null)) {
                continue;
            }

            foreach ($msg['content'] as &$block) {
                if (($block['type'] ?? '') === 'tool_result') {
                    $block['content'] = '[Earlier tool result removed — call the tool again if needed]';
                }
            }
        }

        return $messages;
    }

    // ── Level 3: Summarize old messages ─────────────────────────

    private static function summarizeOldMessages(array $messages, int $keepRecent, string $existingSummary): array
    {
        $total = count($messages);
        $cutoff = max(0, $total - $keepRecent);

        if ($cutoff <= 1) {
            return ['messages' => $messages, 'summary' => $existingSummary];
        }

        $oldMessages = array_slice($messages, 0, $cutoff);
        $recentMessages = array_slice($messages, $cutoff);

        // Try LLM-powered summary first, fall back to mechanical
        $summary = self::generateLlmSummary($oldMessages);
        if (! $summary) {
            $summary = self::buildMechanicalSummary($oldMessages);
        }

        // Merge with existing rolling summary
        if ($existingSummary) {
            $summary = "## Previous context\n{$existingSummary}\n\n## This session\n{$summary}";
        }

        $compressed = [];
        $compressed[] = [
            'role' => 'user',
            'content' => "[Conversation history — older messages were compressed]\n\n{$summary}\n\n[End of summary. Recent messages follow. Call tools again if you need data from earlier.]",
        ];
        $compressed[] = [
            'role' => 'assistant',
            'content' => [['type' => 'text', 'text' => 'Understood, I have the conversation context.']],
        ];

        return [
            'messages' => array_merge($compressed, $recentMessages),
            'summary' => $summary,
        ];
    }

    // ── Smart tool result summaries ─────────────────────────────

    private static function summarizeToolResult(string $json): string
    {
        $data = json_decode($json, true);
        if (! is_array($data)) {
            return '[Tool result: '.strlen($json).' bytes]';
        }

        // Content list (posts/pages/products/etc.)
        if (isset($data['posts']) && is_array($data['posts'])) {
            return self::summarizeContentList($data);
        }

        // Single content item
        if (isset($data['id']) && (isset($data['title']) || isset($data['name']))) {
            return self::summarizeSingleItem($data);
        }

        // Form data
        if (isset($data['fields']) && isset($data['title'])) {
            return self::summarizeForm($data);
        }

        // Site map
        if (isset($data['menu']) || isset($data['disconnected'])) {
            return self::summarizeSiteMap($data);
        }

        // Translation audit
        if (isset($data['missing']) || isset($data['audit'])) {
            return self::summarizeAudit($data);
        }

        // Generic: show keys and sizes
        $keys = array_keys($data);

        return '[Result: '.strlen($json).' bytes, keys: '.implode(', ', array_slice($keys, 0, 10)).']';
    }

    private static function summarizeContentList(array $data): string
    {
        $count = count($data['posts']);
        $total = $data['total'] ?? $count;
        $items = array_map(function ($post) {
            $id = $post['id'] ?? '?';
            $title = self::extractTitle($post);
            $status = $post['status'] ?? '';
            $lang = $post['lang'] ?? $post['language'] ?? '';
            $parts = ["ID {$id}: \"{$title}\""];
            if ($status) {
                $parts[] = $status;
            }
            if ($lang) {
                $parts[] = "({$lang})";
            }

            return implode(' ', $parts);
        }, array_slice($data['posts'], 0, 25));

        $summary = "[Content list: {$total} total]\n".implode("\n", $items);
        if ($count > 25) {
            $summary .= "\n... +".($count - 25).' more';
        }

        return $summary;
    }

    private static function summarizeSingleItem(array $data): string
    {
        $id = $data['id'] ?? '?';
        $title = self::extractTitle($data);
        $status = $data['status'] ?? '';
        $type = $data['type'] ?? '';

        $parts = ["[Item: ID {$id}, \"{$title}\""];
        if ($type) {
            $parts[] = "type={$type}";
        }
        if ($status) {
            $parts[] = "status={$status}";
        }

        // Include block structure if present
        $content = $data['content']['rendered'] ?? $data['content'] ?? '';
        if (is_string($content) && strlen($content) > 100) {
            preg_match_all('/<!-- wp:([a-z\/-]+)/', $content, $blocks);
            if (! empty($blocks[1])) {
                $blockCounts = array_count_values($blocks[1]);
                $blockSummary = array_map(fn ($name, $c) => "{$name}×{$c}", array_keys($blockCounts), $blockCounts);
                $parts[] = 'blocks: '.implode(', ', array_slice($blockSummary, 0, 10));
            }
        }

        return implode(', ', $parts).']';
    }

    private static function summarizeForm(array $data): string
    {
        $id = $data['id'] ?? '?';
        $title = $data['title'] ?? '?';
        $fieldCount = count($data['fields'] ?? []);
        $fields = array_map(fn ($f) => ($f['label'] ?? $f['type'] ?? '?'), array_slice($data['fields'] ?? [], 0, 10));
        $notifCount = count($data['notifications'] ?? []);

        return "[Form #{$id}: \"{$title}\", {$fieldCount} fields (".implode(', ', $fields)."), {$notifCount} notifications]";
    }

    private static function summarizeSiteMap(array $data): string
    {
        $menuName = $data['menu']['name'] ?? 'unknown';
        $menuItems = count($data['menu']['items'] ?? []);
        $disconnected = count($data['disconnected'] ?? []);

        return "[Site map: menu \"{$menuName}\" ({$menuItems} top-level items), {$disconnected} disconnected pages]";
    }

    private static function summarizeAudit(array $data): string
    {
        return '[Audit result: '.json_encode(array_map(fn ($v) => is_array($v) ? count($v).' items' : $v, $data)).']';
    }

    // ── Helpers ──────────────────────────────────────────────────

    private static function getCheapestModel(): ?string
    {
        $available = ProviderRegistry::getAvailable();

        // Priority: Gemini Flash > Haiku > anything else
        $preferences = ['gemini:gemini-flash', 'anthropic:haiku', 'groq:llama-scout'];
        foreach ($preferences as $key) {
            [$provider] = explode(':', $key);
            if (isset($available[$provider])) {
                return $key;
            }
        }

        // Fall back to default
        return ProviderRegistry::getDefaultModelKey();
    }

    private static function buildConversationText(array $messages): string
    {
        $parts = [];
        foreach ($messages as $msg) {
            $role = ucfirst($msg['role'] ?? 'unknown');
            $text = self::extractText($msg['content'] ?? '');

            if (is_array($msg['content'] ?? null)) {
                foreach ($msg['content'] as $block) {
                    if (($block['type'] ?? '') === 'tool_use') {
                        $name = str_replace('__', '/', $block['name'] ?? '');
                        $parts[] = "[Tool call: {$name}]";
                    } elseif (($block['type'] ?? '') === 'tool_result') {
                        $content = $block['content'] ?? '';
                        $parts[] = '[Tool result: '.self::truncateText($content, 200).']';
                    }
                }
            }

            if ($text) {
                $parts[] = "{$role}: ".self::truncateText($text, 500);
            }
        }

        return implode("\n", $parts);
    }

    private static function buildMechanicalSummary(array $messages): string
    {
        $parts = [];
        $toolCalls = [];

        foreach ($messages as $msg) {
            $role = $msg['role'] ?? '';
            $content = $msg['content'] ?? '';

            if ($role === 'user') {
                $text = self::extractText($content);
                if ($text && ! str_starts_with($text, '[')) {
                    $parts[] = 'User: '.self::truncateText($text, 200);
                }
            } elseif ($role === 'assistant' && is_array($content)) {
                foreach ($content as $block) {
                    if (($block['type'] ?? '') === 'tool_use') {
                        $name = str_replace('__', '/', $block['name'] ?? '');
                        $toolCalls[] = $name;
                        $parts[] = "Tool: {$name}";
                    } elseif (($block['type'] ?? '') === 'text') {
                        $text = trim($block['text'] ?? '');
                        if ($text) {
                            $parts[] = 'Assistant: '.self::truncateText($text, 300);
                        }
                    }
                }
            }
        }

        $summary = implode("\n", $parts);
        if ($toolCalls) {
            $summary .= "\n\nTools used: ".implode(', ', array_unique($toolCalls));
        }

        return $summary;
    }

    private static function extractText(mixed $content): string
    {
        if (is_string($content)) {
            return trim($content);
        }
        if (is_array($content)) {
            $texts = [];
            foreach ($content as $block) {
                if (($block['type'] ?? '') === 'text') {
                    $texts[] = $block['text'] ?? '';
                }
            }

            return trim(implode(' ', $texts));
        }

        return '';
    }

    private static function extractTitle(array $data): string
    {
        $title = $data['title']['rendered'] ?? $data['title']['raw'] ?? $data['title'] ?? $data['name'] ?? '?';
        if (is_array($title)) {
            $title = $title['rendered'] ?? $title['raw'] ?? '?';
        }

        return (string) $title;
    }

    private static function truncateText(string $text, int $maxLen): string
    {
        return mb_strlen($text) > $maxLen ? mb_substr($text, 0, $maxLen - 3).'...' : $text;
    }

    public static function estimateTokens(array $messages): int
    {
        $imageCount = 0;
        // Strip image data before estimating — base64 would massively inflate the count
        $stripped = array_map(function ($msg) use (&$imageCount) {
            if (! is_array($msg['content'] ?? null)) {
                return $msg;
            }
            $msg['content'] = array_map(function ($block) use (&$imageCount) {
                if (($block['type'] ?? '') === 'image') {
                    $imageCount++;

                    return ['type' => 'image', 'source' => '[stripped]'];
                }

                return $block;
            }, $msg['content']);

            return $msg;
        }, $messages);

        // ~1500 tokens per image (typical for vision models)
        return (int) (strlen(json_encode($stripped)) / self::CHARS_PER_TOKEN) + ($imageCount * 1500);
    }

    /**
     * Strip image blocks from old messages to keep context manageable.
     * Replaces images with a placeholder text block.
     */
    public static function stripOldImages(array $messages, int $keepRecent = 4): array
    {
        $total = count($messages);
        foreach ($messages as $i => &$msg) {
            if ($i >= $total - $keepRecent) {
                break; // Keep recent messages intact
            }
            if (! is_array($msg['content'] ?? null)) {
                continue;
            }
            $msg['content'] = array_map(function ($block) {
                if (($block['type'] ?? '') === 'image') {
                    return ['type' => 'text', 'text' => '[image removed for context compression]'];
                }

                return $block;
            }, $msg['content']);
        }

        return $messages;
    }
}
