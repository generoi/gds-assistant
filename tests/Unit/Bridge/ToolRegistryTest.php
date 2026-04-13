<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\ToolProviderInterface;
use GeneroWP\Assistant\Bridge\ToolRegistry;
use WP_UnitTestCase;

class ToolRegistryTest extends WP_UnitTestCase
{
    public function test_register_and_get_tools(): void
    {
        $registry = new ToolRegistry;
        $provider = $this->createMockProvider('test__tool', ['name' => 'test__tool', 'description' => 'A test tool', 'input_schema' => ['type' => 'object']]);

        $registry->register($provider);
        $tools = $registry->getAllTools();

        $this->assertCount(1, $tools);
        $this->assertEquals('test__tool', $tools[0]['name']);
    }

    public function test_execute_routes_to_correct_provider(): void
    {
        $registry = new ToolRegistry;

        $provider1 = $this->createMockProvider('gds__foo', ['name' => 'gds__foo', 'description' => 'Foo', 'input_schema' => ['type' => 'object']]);
        $provider2 = $this->createMockProvider('other__bar', ['name' => 'other__bar', 'description' => 'Bar', 'input_schema' => ['type' => 'object']]);

        $registry->register($provider1);
        $registry->register($provider2);

        // provider1 handles gds__ prefix, should execute
        $result = $registry->executeTool('gds__foo', []);
        $this->assertEquals(['executed' => 'gds__foo'], $result);
    }

    public function test_execute_returns_error_for_unhandled_tool(): void
    {
        $registry = new ToolRegistry;
        $result = $registry->executeTool('unknown__tool', []);

        $this->assertWPError($result);
        $this->assertEquals('tool_not_found', $result->get_error_code());
    }

    public function test_multiple_providers_merge_tools(): void
    {
        $registry = new ToolRegistry;

        $p1 = $this->createMockProvider('gds__a', ['name' => 'gds__a', 'description' => 'A', 'input_schema' => ['type' => 'object']]);
        $p2 = $this->createMockProvider('other__b', ['name' => 'other__b', 'description' => 'B', 'input_schema' => ['type' => 'object']]);

        $registry->register($p1);
        $registry->register($p2);

        $tools = $registry->getAllTools();
        $this->assertCount(2, $tools);
    }

    private function createMockProvider(string $toolName, array $toolDef): ToolProviderInterface
    {
        $prefix = explode('__', $toolName)[0].'__';

        return new class($prefix, $toolDef) implements ToolProviderInterface
        {
            public function __construct(
                private readonly string $prefix,
                private readonly array $toolDef,
            ) {}

            public function getTools(): array
            {
                return [$this->toolDef];
            }

            public function executeTool(string $name, array $input): mixed
            {
                return ['executed' => $name];
            }

            public function handles(string $name): bool
            {
                return str_starts_with($name, $this->prefix);
            }
        };
    }
}
