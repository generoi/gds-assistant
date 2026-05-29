<?php

namespace GeneroWP\Assistant\Llm;

/**
 * Common LLM pipeline shapes. We deliberately stay on array shapes (not
 * value classes) for messages and content blocks: most of the data here is
 * a translation layer between our pipeline and 3 different provider wire
 * formats, where the shape churns whenever a provider adds something
 * provider-specific (Anthropic's `advisor_tool_result`, `web_search_*`,
 * Gemini's `function_call`, …). The aliases below pin down what we *do*
 * know — role, the string-or-blocks union, the `type` discriminator — so
 * PHPStan catches typos and missing keys at read sites without forcing
 * every consumer through a class hierarchy with an escape hatch.
 *
 * `LlmContentBlock` is keyed by `type`; the other fields vary per block
 * type (`text` for text blocks, `id`/`name`/`input` for tool_use,
 * `tool_use_id`/`content` for tool_result, `source` for image, …) and
 * are left as `mixed` because providers add their own.
 *
 * @phpstan-type LlmContentBlock array{type: string, ...<string, mixed>}
 * @phpstan-type LlmMessage array{role: string, content: string|list<LlmContentBlock>}
 * @phpstan-type LlmTool array{name: string, description?: string, input_schema?: array<string, mixed>}
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
