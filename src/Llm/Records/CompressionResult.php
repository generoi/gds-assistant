<?php

namespace GeneroWP\Assistant\Llm\Records;

use GeneroWP\Assistant\Llm\ContextCompressor;

/**
 * Result of {@see ContextCompressor::compress()} —
 * a (possibly-shortened) message list together with the updated rolling
 * summary the caller should persist.
 *
 * The compressor walks four cumulative levels (truncate large tool results,
 * strip old images, strip old tool_result content, generate an LLM summary)
 * and stops at the first one that fits the token budget. The `messages`
 * shape is unchanged from the input — only the contents shrink. `summary`
 * carries the previous summary forward verbatim when no level-3
 * summarization happened this call.
 */
final class CompressionResult
{
    /**
     * @param  array<int, array<string, mixed>>  $messages  The compressed message list (same shape as the input).
     * @param  string  $summary  Rolling summary; either unchanged or with a fresh LLM-generated section appended.
     */
    public function __construct(
        public readonly array $messages,
        public readonly string $summary,
    ) {}
}
