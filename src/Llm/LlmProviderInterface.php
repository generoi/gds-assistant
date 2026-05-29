<?php

namespace GeneroWP\Assistant\Llm;

/**
 * @phpstan-type LlmMessage array<string, mixed>
 * @phpstan-type LlmTool array<string, mixed>
 * @phpstan-type LlmContentBlock array<string, mixed>
 * @phpstan-type LlmEventCallback callable(string, array<string, mixed>): void
 */
interface LlmProviderInterface
{
    /**
     * Stream a message completion with tools.
     *
     * The callback receives SSE events: fn(string $eventType, array $data)
     * Event types: text_delta, tool_use_start, tool_result, message_stop, error
     *
     * @param  array<int, LlmMessage>  $messages  Conversation messages [{role, content}]
     * @param  array<int, LlmTool>  $tools  Tool definitions [{name, description, input_schema}]
     * @param  LlmEventCallback  $onEvent  SSE event callback
     * @param  string|null  $systemPrompt  System prompt
     * @return array<int, LlmContentBlock> Final assistant message content blocks
     */
    public function stream(
        array $messages,
        array $tools,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array;

    /** Provider identifier (e.g. 'anthropic', 'openai') */
    public function name(): string;
}
