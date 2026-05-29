<?php

namespace GeneroWP\Assistant\Bridge;

interface ToolProviderInterface
{
    /**
     * Get tool definitions in LLM-compatible format.
     *
     * Providers may return a numerically-indexed list (most do) or a
     * name-keyed map — callers downstream merge into a single tool list
     * either way. Schemas can carry extra keys (min_tier, etc.); the
     * shape below is the minimum contract.
     *
     * @return list<array{name: string, description: string, input_schema: array<string, mixed>}>
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
