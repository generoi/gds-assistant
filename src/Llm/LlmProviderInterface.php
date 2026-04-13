<?php

namespace GeneroWP\Assistant\Llm;

interface LlmProviderInterface
{
    /**
     * Stream a message completion with tools.
     *
     * The callback receives SSE events: fn(string $eventType, array $data)
     * Event types: text_delta, tool_use_start, tool_result, message_stop, error
     *
     * @param  array  $messages  Conversation messages [{role, content}]
     * @param  array  $tools  Tool definitions [{name, description, input_schema}]
     * @param  callable  $onEvent  SSE event callback
     * @param  string|null  $systemPrompt  System prompt
     * @return array Final assistant message content blocks
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
