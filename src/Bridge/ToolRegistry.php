<?php

namespace GeneroWP\Assistant\Bridge;

class ToolRegistry
{
    /** @var ToolProviderInterface[] */
    private array $providers = [];

    public function register(ToolProviderInterface $provider): void
    {
        $this->providers[] = $provider;
    }

    /**
     * Get all tool definitions from all providers.
     *
     * @return array<int, array{name: string, description: string, input_schema: array}>
     */
    public function getAllTools(): array
    {
        $tools = [];
        foreach ($this->providers as $provider) {
            foreach ($provider->getTools() as $tool) {
                $tools[] = $tool;
            }
        }

        return $tools;
    }

    /**
     * Execute a tool, routing to the correct provider.
     *
     * @return mixed|\WP_Error
     */
    public function executeTool(string $name, array $input): mixed
    {
        foreach ($this->providers as $provider) {
            if ($provider->handles($name)) {
                return $provider->executeTool($name, $input);
            }
        }

        return new \WP_Error(
            'tool_not_found',
            "No provider registered for tool: {$name}",
        );
    }
}
