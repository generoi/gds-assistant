<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Api\ChatEndpoint;
use GeneroWP\Assistant\Plugin;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Tests\TestCase;

/**
 * The client-tool round-trip: the browser runs an editor tool and POSTs its
 * result, which the server splices into the pending_client stub so the loop
 * can resume. Mirrors the human-approval splice.
 */
class EditorRoundTripTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        AuditLog::createTables();
        wp_set_current_user($this->createAdminUser());
    }

    private function splice(array $messages, array $results, callable $onEvent): array
    {
        $m = new \ReflectionMethod(ChatEndpoint::class, 'handleClientToolResults');
        $m->setAccessible(true);

        return $m->invoke(new ChatEndpoint(Plugin::getInstance()), $messages, $results, $onEvent, 'conv-1', get_current_user_id());
    }

    private function editorPrompt(array $ctx): string
    {
        $m = new \ReflectionMethod(ChatEndpoint::class, 'editorContextPrompt');
        $m->setAccessible(true);

        return $m->invoke(new ChatEndpoint(Plugin::getInstance()), $ctx);
    }

    /**
     * The open-editor system prompt must NOT vary with the current selection —
     * baking the selection snapshot in would change the cached system block on
     * every selection change and bust the prompt cache for the whole
     * system + tools prefix. The model gets selection via editor__read_selection.
     */
    public function test_editor_context_prompt_is_selection_invariant(): void
    {
        $base = ['has_editor' => true, 'post_id' => 7, 'post_type' => 'page', 'custom_colors' => true];

        $oneSelected = $this->editorPrompt($base + ['selected_block_count' => 1, 'selected_block_types' => ['core/heading']]);
        $threeSelected = $this->editorPrompt($base + ['selected_block_count' => 3, 'selected_block_types' => ['core/paragraph']]);
        $nothing = $this->editorPrompt($base + ['selected_block_count' => 0]);

        $this->assertSame($oneSelected, $threeSelected);
        $this->assertSame($oneSelected, $nothing);
        $this->assertStringNotContainsString('block(s) selected', $oneSelected);
        // The stable post anchor is fine (changes only when you switch posts).
        $this->assertStringContainsString('post #7', $oneSelected);
    }

    public function test_client_result_replaces_pending_stub_and_emits_event(): void
    {
        $messages = [
            ['role' => 'assistant', 'content' => [
                ['type' => 'tool_use', 'id' => 'tu_1', 'name' => 'editor__replace_blocks', 'input' => ['client_ids' => ['abc'], 'markup' => '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->']],
            ]],
            ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 'tu_1', 'content' => json_encode(['status' => 'pending_client']), 'is_error' => false],
            ]],
        ];

        $events = [];
        $out = $this->splice(
            $messages,
            [['tool_use_id' => 'tu_1', 'result' => ['ok' => true, 'replaced' => 1], 'is_error' => false]],
            function ($type, $data) use (&$events) {
                $events[] = [$type, $data];
            },
        );

        // The stub now carries the real result.
        $resolved = json_decode($out[1]['content'][0]['content'], true);
        $this->assertTrue($resolved['ok']);
        $this->assertFalse($out[1]['content'][0]['is_error']);

        // A tool_result event was emitted so the UI card updates.
        $toolResults = array_values(array_filter($events, fn ($e) => $e[0] === 'tool_result'));
        $this->assertCount(1, $toolResults);
        $this->assertSame('tu_1', $toolResults[0][1]['tool_use_id']);
    }

    public function test_error_result_is_marked_as_error(): void
    {
        $messages = [
            ['role' => 'assistant', 'content' => [
                ['type' => 'tool_use', 'id' => 'tu_2', 'name' => 'editor__replace_blocks', 'input' => []],
            ]],
            ['role' => 'user', 'content' => [
                ['type' => 'tool_result', 'tool_use_id' => 'tu_2', 'content' => json_encode(['status' => 'pending_client']), 'is_error' => false],
            ]],
        ];

        $out = $this->splice(
            $messages,
            [['tool_use_id' => 'tu_2', 'result' => ['error' => 'Invalid block markup'], 'is_error' => true]],
            fn () => null,
        );

        $this->assertTrue($out[1]['content'][0]['is_error']);
        $resolved = json_decode($out[1]['content'][0]['content'], true);
        $this->assertSame('Invalid block markup', $resolved['error']);
    }
}
