<?php

namespace GeneroWP\Assistant\Llm;

/**
 * 3-level progressive context compression for long conversations.
 *
 * Level 1: Truncate large tool results to structured summaries (free)
 * Level 2: Drop old tool_result content entirely (free)
 * Level 3: Summarize old conversation via LLM call (costs 1 API call)
 *
 * User messages are preserved longer than assistant/tool messages.
 * Full conversation is always in the DB — LLM can re-fetch via tools.
 */
class ContextCompressor
{
    /** Rough token estimate: 1 token ≈ 4 chars of JSON */
    private const CHARS_PER_TOKEN = 4;

    /** Level 1: truncate individual tool results over this size */
    private const TOOL_RESULT_MAX_CHARS = 8000; // ~2K tokens

    /** Level 2 triggers at this token threshold */
    private const LEVEL2_THRESHOLD = 50000;

    /** Level 3 triggers at this token threshold */
    private const LEVEL3_THRESHOLD = 80000;

    /** Keep this many recent messages in full (never compressed) */
    private const KEEP_RECENT = 6;

    /**
     * Compress messages to fit within reasonable token limits.
     *
     * @param  array  $messages  Full conversation messages
     * @return array Compressed messages
     */
    public static function compress(array $messages): array
    {
        $thresholdL2 = apply_filters('gds-assistant/compression_threshold', self::LEVEL2_THRESHOLD);
        $thresholdL3 = apply_filters('gds-assistant/summary_threshold', self::LEVEL3_THRESHOLD);
        $keepRecent = apply_filters('gds-assistant/keep_recent_messages', self::KEEP_RECENT);

        $tokens = self::estimateTokens($messages);

        // Under threshold — no compression needed
        if ($tokens < $thresholdL2) {
            return $messages;
        }

        // Level 1: Truncate large tool results everywhere
        $messages = self::truncateLargeToolResults($messages);
        $tokens = self::estimateTokens($messages);

        if ($tokens < $thresholdL2) {
            return $messages;
        }

        // Level 2: Strip old tool_result content (keep recent messages intact)
        $messages = self::stripOldToolResults($messages, $keepRecent);
        $tokens = self::estimateTokens($messages);

        if ($tokens < $thresholdL3) {
            return $messages;
        }

        // Level 3: Summarize old conversation (replace old messages with summary)
        $messages = self::summarizeOldMessages($messages, $keepRecent);

        return $messages;
    }

    /**
     * Level 1: Truncate individual tool_result content blocks over the size limit.
     * Keeps a structured summary with key data points (IDs, titles, counts).
     */
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

                // Extract a structured summary from the JSON
                $block['content'] = self::summarizeToolResult($content);
            }
        }

        return $messages;
    }

    /**
     * Level 2: Replace old tool_result content with placeholders.
     * Preserves the last $keepRecent messages in full.
     */
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
                    $toolId = $block['tool_use_id'] ?? '';
                    $block['content'] = "[Previous tool result for {$toolId} — call the tool again if you need the data]";
                }
            }
        }

        return $messages;
    }

    /**
     * Level 3: Replace old messages with a conversation summary.
     * Extracts key facts from old messages and consolidates into one message.
     */
    private static function summarizeOldMessages(array $messages, int $keepRecent): array
    {
        $total = count($messages);
        $cutoff = max(0, $total - $keepRecent);

        if ($cutoff <= 1) {
            return $messages;
        }

        $oldMessages = array_slice($messages, 0, $cutoff);
        $recentMessages = array_slice($messages, $cutoff);

        // Build a summary from old messages
        $summary = self::buildConversationSummary($oldMessages);

        // Prepend summary as a user message, then append recent messages
        $compressed = [];
        $compressed[] = [
            'role' => 'user',
            'content' => "[Conversation history summary — older messages were compressed to save context]\n\n".$summary."\n\n[End of summary. Recent messages follow. If you need details from the summary, call the relevant tool again to get fresh data.]",
        ];

        // Need an assistant acknowledgment for valid message alternation
        $compressed[] = [
            'role' => 'assistant',
            'content' => [['type' => 'text', 'text' => 'Understood, I have the conversation context. Continuing.']],
        ];

        return array_merge($compressed, $recentMessages);
    }

    /**
     * Build a text summary from old messages.
     * Extracts: user requests, tool calls made, key results, decisions.
     */
    private static function buildConversationSummary(array $messages): string
    {
        $parts = [];
        $toolCalls = [];

        foreach ($messages as $msg) {
            $role = $msg['role'] ?? '';
            $content = $msg['content'] ?? '';

            if ($role === 'user') {
                $text = is_string($content) ? $content : '';
                if (is_array($content)) {
                    // Extract text parts, skip tool_results
                    foreach ($content as $block) {
                        if (($block['type'] ?? '') === 'text') {
                            $text .= $block['text'] ?? '';
                        }
                    }
                }
                $text = trim($text);
                if ($text && ! str_starts_with($text, '[')) {
                    // Truncate long user messages
                    if (mb_strlen($text) > 200) {
                        $text = mb_substr($text, 0, 197).'...';
                    }
                    $parts[] = "User: {$text}";
                }
            } elseif ($role === 'assistant') {
                if (is_array($content)) {
                    foreach ($content as $block) {
                        if (($block['type'] ?? '') === 'tool_use') {
                            $name = str_replace('__', '/', $block['name'] ?? '');
                            $input = $block['input'] ?? [];
                            $inputSummary = is_string($input) ? $input : json_encode($input);
                            if (strlen($inputSummary) > 100) {
                                $inputSummary = substr($inputSummary, 0, 97).'...';
                            }
                            $toolCalls[] = $name;
                            $parts[] = "Tool called: {$name} ({$inputSummary})";
                        } elseif (($block['type'] ?? '') === 'text') {
                            $text = trim($block['text'] ?? '');
                            if ($text && mb_strlen($text) > 300) {
                                $text = mb_substr($text, 0, 297).'...';
                            }
                            if ($text) {
                                $parts[] = "Assistant: {$text}";
                            }
                        }
                    }
                } elseif (is_string($content)) {
                    $text = trim($content);
                    if ($text && mb_strlen($text) > 300) {
                        $text = mb_substr($text, 0, 297).'...';
                    }
                    if ($text) {
                        $parts[] = "Assistant: {$text}";
                    }
                }
            }
        }

        $summary = implode("\n", $parts);

        if ($toolCalls) {
            $uniqueTools = array_unique($toolCalls);
            $summary .= "\n\nTools used in this conversation: ".implode(', ', $uniqueTools);
        }

        return $summary;
    }

    /**
     * Summarize a large tool result JSON into a compact structured format.
     * Keeps IDs, titles, counts — drops full content/HTML/meta.
     */
    private static function summarizeToolResult(string $json): string
    {
        $data = json_decode($json, true);
        if (! is_array($data)) {
            return '[Tool result truncated: '.strlen($json).' bytes]';
        }

        // List response with posts array
        if (isset($data['posts']) && is_array($data['posts'])) {
            $count = count($data['posts']);
            $total = $data['total'] ?? $count;
            $items = array_map(function ($post) {
                $id = $post['id'] ?? '?';
                $title = $post['title']['rendered'] ?? $post['title'] ?? '?';
                if (is_array($title)) {
                    $title = $title['rendered'] ?? $title['raw'] ?? '?';
                }
                $status = $post['status'] ?? '';

                return "ID {$id}: \"{$title}\" ({$status})";
            }, array_slice($data['posts'], 0, 20));

            $summary = "[List result: {$total} total, showing {$count}]\n".implode("\n", $items);
            if ($count > 20) {
                $summary .= "\n... and ".($count - 20).' more';
            }

            return $summary;
        }

        // Single item response
        if (isset($data['id'])) {
            $id = $data['id'];
            $title = $data['title']['rendered'] ?? $data['title'] ?? '';
            if (is_array($title)) {
                $title = $title['rendered'] ?? $title['raw'] ?? '';
            }
            $status = $data['status'] ?? '';
            $type = $data['type'] ?? '';

            return "[Item: ID {$id}, \"{$title}\", status={$status}, type={$type}]";
        }

        // Generic fallback — show keys and sizes
        $keys = array_keys($data);
        $keySummary = implode(', ', array_slice($keys, 0, 10));

        return '[Tool result truncated: '.strlen($json)." bytes, keys: {$keySummary}]";
    }

    /**
     * Estimate token count from messages.
     */
    public static function estimateTokens(array $messages): int
    {
        return (int) (strlen(json_encode($messages)) / self::CHARS_PER_TOKEN);
    }
}
