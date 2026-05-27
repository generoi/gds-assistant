<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\EditorToolProvider;
use GeneroWP\Assistant\Tests\TestCase;

class EditorToolProviderTest extends TestCase
{
    public function test_provides_the_block_tools(): void
    {
        $names = array_column((new EditorToolProvider)->getTools(), 'name');

        $this->assertContains('editor__read_selection', $names);
        $this->assertContains('editor__replace_blocks', $names);
        $this->assertContains('editor__insert_blocks', $names);
        $this->assertContains('editor__update_block_attributes', $names);
    }

    public function test_is_client_tool_matches_only_editor_prefix(): void
    {
        $this->assertTrue(EditorToolProvider::isClientTool('editor__replace_blocks'));
        $this->assertTrue(EditorToolProvider::isClientTool('editor__read_selection'));
        $this->assertFalse(EditorToolProvider::isClientTool('gds__content-list'));
        $this->assertFalse(EditorToolProvider::isClientTool('assistant__undo'));
    }

    public function test_execute_is_a_server_side_safety_net(): void
    {
        $result = (new EditorToolProvider)->executeTool('editor__replace_blocks', []);
        $this->assertWPError($result);
        $this->assertSame('client_tool', $result->get_error_code());
    }
}
