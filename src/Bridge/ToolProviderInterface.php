<?php

namespace GeneroWP\Assistant\Bridge;

interface ToolProviderInterface
{
    /**
     * Get tool definitions in LLM-compatible format.
     *
     * @return array<string, array{name: string, description: string, input_schema: array}>
     */
    public function getTools(): array;

    /**
     * Execute a tool by name.
     *
     * @return mixed|\WP_Error Result data or error
     */
    public function executeTool(string $name, array $input): mixed;

    /** Whether this provider handles the given tool name. */
    public function handles(string $name): bool;
}
