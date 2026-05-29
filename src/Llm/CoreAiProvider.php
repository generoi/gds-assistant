<?php

namespace GeneroWP\Assistant\Llm;

/**
 * WordPress 7 AI Client provider.
 *
 * This intentionally routes through wp_ai_client_prompt() so provider choice,
 * credentials, and capability checks live in WordPress core/connectors.
 */
final class CoreAiProvider implements LlmProviderInterface
{
    /**
     * @param  string[]  $modelPreference
     */
    public function __construct(
        private readonly array $modelPreference = [],
        private readonly int $maxTokens = 4096,
    ) {}

    public function name(): string
    {
        return 'wordpress';
    }

    public function stream(
        array $messages,
        array $tools,
        callable $onEvent,
        ?string $systemPrompt = null,
    ): array {
        $result = self::generateAssistantTurn(
            messages: $messages,
            tools: $tools,
            systemPrompt: $systemPrompt,
            maxTokens: $this->maxTokens,
            modelPreference: $this->modelPreference,
        );

        if (is_wp_error($result)) {
            $onEvent('error', ['message' => $result->get_error_message()]);

            return [];
        }

        $blocks = [];

        if (! empty($result['answer'])) {
            $answer = (string) $result['answer'];
            $blocks[] = [
                'type' => 'text',
                'text' => $answer,
            ];
            $onEvent('text_delta', ['text' => $answer]);
        }

        $toolCallsAdded = 0;
        foreach ($result['tool_calls'] as $toolCall) {
            $name = (string) $toolCall['name'];
            if (! self::toolExists($name, $tools)) {
                continue;
            }

            $input = $toolCall['input'];
            $block = [
                'type' => 'tool_use',
                'id' => 'wpai_'.wp_generate_uuid4(),
                'name' => $name,
                'input' => $input !== [] ? $input : new \stdClass,
            ];
            $blocks[] = $block;
            $toolCallsAdded++;
            $onEvent('tool_use_start', [
                'id' => $block['id'],
                'name' => $name,
                'input' => $block['input'],
            ]);
        }

        if ($toolCallsAdded === 0) {
            $onEvent('message_stop', ['stop_reason' => 'end_turn']);
        }

        return $blocks;
    }

    /**
     * @param  array<int, array<string, mixed>>  $messages
     * @param  string[]  $modelPreference
     */
    public static function generateText(array $messages, ?string $systemPrompt = null, int $maxTokens = 4096, array $modelPreference = []): string|\WP_Error
    {
        if (! AiSupport::supportsCoreTextGeneration()) {
            return new \WP_Error('ai_client_unavailable', AiSupport::unavailableMessage());
        }

        $builder = wp_ai_client_prompt(self::messagesToPrompt($messages));

        if ($systemPrompt && method_exists($builder, 'using_system_instruction')) {
            $builder = $builder->using_system_instruction($systemPrompt);
        }

        if (method_exists($builder, 'using_max_tokens')) {
            $builder = $builder->using_max_tokens($maxTokens);
        }

        if (! empty($modelPreference) && method_exists($builder, 'using_model_preference')) {
            $builder = $builder->using_model_preference(...$modelPreference);
        }

        return $builder->generate_text();
    }

    /**
     * @param  array<int, array<string, mixed>>  $messages
     * @param  array<int, array<string, mixed>>  $tools
     * @param  string[]  $modelPreference
     * @return array{answer: string, tool_calls: array<int, array{name: string, input: array<string, mixed>}>}|\WP_Error
     */
    public static function generateAssistantTurn(array $messages, array $tools, ?string $systemPrompt = null, int $maxTokens = 4096, array $modelPreference = []): array|\WP_Error
    {
        if (! AiSupport::supportsCoreTextGeneration()) {
            return new \WP_Error('ai_client_unavailable', AiSupport::unavailableMessage());
        }

        $schema = [
            'type' => 'object',
            'properties' => [
                'answer' => [
                    'type' => 'string',
                    'description' => 'Natural language answer to show the user. Leave empty when calling tools first.',
                ],
                'tool_calls' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'name' => ['type' => 'string'],
                            'input' => ['type' => 'object', 'additionalProperties' => true],
                        ],
                        'required' => ['name', 'input'],
                    ],
                ],
            ],
            'required' => ['answer', 'tool_calls'],
        ];

        $builder = wp_ai_client_prompt(self::agentPrompt($messages, $tools));

        if ($systemPrompt && method_exists($builder, 'using_system_instruction')) {
            $builder = $builder->using_system_instruction($systemPrompt."\n\n".self::agentSystemInstruction());
        }

        if (method_exists($builder, 'using_max_tokens')) {
            $builder = $builder->using_max_tokens($maxTokens);
        }

        if (! empty($modelPreference) && method_exists($builder, 'using_model_preference')) {
            $builder = $builder->using_model_preference(...$modelPreference);
        }

        if (method_exists($builder, 'as_json_response')) {
            $builder = $builder->as_json_response($schema);
        }

        $json = $builder->generate_text();
        if (is_wp_error($json)) {
            return $json;
        }

        $decoded = json_decode((string) $json, true);
        if (! is_array($decoded)) {
            return [
                'answer' => trim((string) $json),
                'tool_calls' => [],
            ];
        }

        return [
            'answer' => (string) ($decoded['answer'] ?? ''),
            'tool_calls' => array_values(array_filter(
                (array) ($decoded['tool_calls'] ?? []),
                fn ($call) => is_array($call) && ! empty($call['name']),
            )),
        ];
    }

    private static function agentSystemInstruction(): string
    {
        return 'Return only JSON matching the requested schema. To use a tool, put it in tool_calls with the exact tool name and JSON input. If a tool is needed, keep answer empty until tool results are available. Do not invent tool names.';
    }

    /**
     * @param  array<int, array<string, mixed>>  $messages
     * @param  array<int, array<string, mixed>>  $tools
     */
    private static function agentPrompt(array $messages, array $tools): string
    {
        return "Conversation:\n\n"
            .self::messagesToPrompt($messages)
            ."\n\nAvailable tools:\n\n"
            .self::toolsToPrompt($tools);
    }

    /** @param array<int, array<string, mixed>> $tools */
    private static function toolsToPrompt(array $tools): string
    {
        if (empty($tools)) {
            return 'No tools are available.';
        }

        $parts = [];
        foreach ($tools as $tool) {
            $parts[] = json_encode([
                'name' => $tool['name'] ?? '',
                'description' => $tool['description'] ?? '',
                'input_schema' => $tool['input_schema'] ?? ['type' => 'object'],
            ]);
        }

        return implode("\n", $parts);
    }

    /** @param array<int, array<string, mixed>> $tools */
    private static function toolExists(string $name, array $tools): bool
    {
        foreach ($tools as $tool) {
            if (($tool['name'] ?? '') === $name) {
                return true;
            }
        }

        return false;
    }

    /** @param array<int, array<string, mixed>> $messages */
    private static function messagesToPrompt(array $messages): string
    {
        $parts = [];

        foreach ($messages as $message) {
            $role = ucfirst((string) ($message['role'] ?? 'user'));
            $content = $message['content'] ?? '';
            $parts[] = "{$role}: ".self::contentToText($content);
        }

        return implode("\n\n", $parts);
    }

    private static function contentToText(mixed $content): string
    {
        if (is_string($content)) {
            return $content;
        }

        if (! is_array($content)) {
            return '';
        }

        $parts = [];
        foreach ($content as $block) {
            if (is_string($block)) {
                $parts[] = $block;
            } elseif (is_array($block) && ($block['type'] ?? '') === 'text') {
                $parts[] = (string) ($block['text'] ?? '');
            }
        }

        return trim(implode("\n", $parts));
    }
}
