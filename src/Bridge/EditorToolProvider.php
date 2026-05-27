<?php

namespace GeneroWP\Assistant\Bridge;

/**
 * Tools that act on the LIVE block editor the user has open — read the current
 * selection and apply block edits to the unsaved document.
 *
 * These are *client-executed*: the server can't touch the editor's in-memory
 * state, so MessageLoop streams a `client_tool_call` event, breaks the loop,
 * and the browser runs the op against `@wordpress/data` and POSTs the result
 * back (mirroring the human-approval round-trip). Hence executeTool() is a
 * safety net that should never run server-side.
 *
 * v1 is blocks-only — whole-block read/replace/insert/attribute edits. Inline
 * text-range edits are intentionally deferred (selection-offset mapping + the
 * browser losing the text selection when focus moves to the chat).
 */
class EditorToolProvider implements ToolProviderInterface
{
    public const PREFIX = 'editor__';

    /** Whether a tool name is one of ours (client-executed in the browser). */
    public static function isClientTool(string $name): bool
    {
        return str_starts_with($name, self::PREFIX);
    }

    public function getTools(): array
    {
        return [
            [
                'name' => 'editor__read_selection',
                'description' => 'Read the user\'s current selection in the open block editor. Returns the selected blocks as Gutenberg block markup plus their clientIds, types, and a flag for whether plain text (not whole blocks) is highlighted. Call this before editing so you edit exactly what the user means. If nothing is selected it returns the whole document.',
                'input_schema' => ['type' => 'object', 'properties' => (object) []],
            ],
            [
                'name' => 'editor__replace_blocks',
                'description' => 'Replace blocks in the open editor with new content. Pass the clientIds to replace (from editor__read_selection) and the replacement as valid Gutenberg block markup (e.g. "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->"). The edit applies live to the unsaved document and is undoable with Cmd/Ctrl+Z. Use registered block types and correct attributes (see gds/block-types-list, gds/blocks-get). The result returns new_client_ids — the live ids of the inserted blocks; use those (not the old ones) for any follow-up edit.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'client_ids' => [
                            'type' => 'array',
                            'items' => ['type' => 'string'],
                            'description' => 'clientIds of the blocks to replace (from editor__read_selection).',
                        ],
                        'markup' => ['type' => 'string', 'description' => 'Replacement Gutenberg block markup.'],
                    ],
                    'required' => ['client_ids', 'markup'],
                ],
            ],
            [
                'name' => 'editor__insert_blocks',
                'description' => 'Insert new blocks (Gutenberg block markup) into the open editor. Without after_client_id they are appended at the end; with it they are inserted directly after that block. Applies live and is undoable. The result returns new_client_ids — the live ids of the inserted blocks — for any follow-up edit.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'markup' => ['type' => 'string', 'description' => 'Gutenberg block markup to insert.'],
                        'after_client_id' => ['type' => 'string', 'description' => 'Optional clientId to insert after; omit to append at the end.'],
                    ],
                    'required' => ['markup'],
                ],
            ],
            [
                'name' => 'editor__update_block_attributes',
                'description' => 'Update attributes of a single block in the open editor (e.g. heading level, text alignment, a URL). Pass the block clientId and an object of attributes to merge. Applies live and is undoable.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'client_id' => ['type' => 'string', 'description' => 'clientId of the block to update.'],
                        'attributes' => ['type' => 'object', 'description' => 'Attributes to merge into the block.'],
                    ],
                    'required' => ['client_id', 'attributes'],
                ],
            ],
            [
                'name' => 'editor__update_post',
                'description' => 'Update the open post\'s own fields live (currently: title — the main title field at the top of the editor, not a block). Applies to the unsaved document and is undoable with Cmd/Ctrl+Z. Use this to set the post title directly.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'title' => ['type' => 'string', 'description' => 'New post title.'],
                    ],
                ],
            ],
        ];
    }

    public function handles(string $name): bool
    {
        return self::isClientTool($name);
    }

    public function executeTool(string $name, array $input): mixed
    {
        // Client-executed — MessageLoop intercepts these before execution and
        // hands them to the browser. Reaching here means something bypassed the
        // round-trip.
        return new \WP_Error(
            'client_tool',
            'Editor tools run in the browser, not on the server.',
        );
    }
}
