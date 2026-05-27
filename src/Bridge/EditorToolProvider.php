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
                'description' => 'Inspect the open editor. Returns selected_blocks (the selection as Gutenberg markup with clientIds; empty if nothing selected), outline (every block incl. nested: clientId, name, depth, text snippet, attributes for non-text blocks like images/galleries/logos, and invalid/unrecognized flags for blocks the editor can\'t validate), and media (attachment id → {title, url, filename}). Match blocks by content, not a remembered clientId — they change after each edit, so re-read before each edit.',
                'input_schema' => ['type' => 'object', 'properties' => (object) []],
            ],
            [
                'name' => 'editor__replace_blocks',
                'description' => 'Replace blocks with new Gutenberg markup (e.g. "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->"). Pass the clientIds to replace and the markup. Returns new_client_ids — use those (not the old ones) for follow-up edits.',
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
                'description' => 'Insert Gutenberg block markup — appended at the end, or directly after after_client_id if given. Returns new_client_ids for follow-up edits.',
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
                'description' => 'Merge attributes into one block by clientId (e.g. heading level, text alignment, a URL).',
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
                'description' => 'Update the open post\'s own fields (currently: title — the title field above the content, not a block).',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'title' => ['type' => 'string', 'description' => 'New post title.'],
                    ],
                ],
            ],
            [
                'name' => 'editor__recover_block',
                'description' => 'Recover blocks the editor flags as "unexpected or invalid content" (invalid in the outline): recreates each from its parsed attributes so it re-serialises to valid markup, like the editor\'s "Attempt Block Recovery". Undoable. Unregistered blocks (unrecognized/core/missing) can\'t be recovered this way — convert those to a Custom HTML block with editor__replace_blocks instead.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'client_ids' => [
                            'type' => 'array',
                            'items' => ['type' => 'string'],
                            'description' => 'clientIds of invalid blocks to recover (from editor__read_selection).',
                        ],
                    ],
                    'required' => ['client_ids'],
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
