/**
 * Shared selection helpers for the live block editor.
 *
 * Used by both the block-toolbar dropdown and the chat composer chip. Keeps a
 * single source of truth for how we read text + selection out of `wp.data` so
 * the two features stay in lock-step (and we only fix things like the WP 7.0
 * RichTextValue object shape in one place).
 */

/** Blocks where text-range selection is meaningful. */
export const TEXT_BLOCKS = new Set([
  'core/paragraph',
  'core/heading',
  'core/list',
  'core/list-item',
  'core/quote',
  'core/pullquote',
  'core/preformatted',
  'core/verse',
]);

/** Friendly block label for human-facing strings ("core/paragraph" → "paragraph"). */
export function blockLabel(name) {
  return (name || '').replace(/^core\//, '').replace(/-/g, ' ');
}

/** Strip HTML + collapse whitespace from a string. */
export function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Block rich-text attributes can be one of two shapes depending on WP version:
 *  - an HTML string (legacy)
 *  - a RichTextValue object with `.text` + `.formats` (WP 7.0+)
 * Normalise both to plain text.
 */
export function attrToPlainText(attrValue) {
  if (typeof attrValue === 'string') {
    const rich = window.wp?.richText?.create?.({html: attrValue});
    if (typeof rich?.text === 'string') return rich.text;
    return stripHtml(attrValue);
  }
  if (
    attrValue &&
    typeof attrValue === 'object' &&
    typeof attrValue.text === 'string'
  ) {
    return attrValue.text;
  }
  return '';
}

/** Plain text of a block's primary content attribute, collapsed + trimmed. */
export function getBlockText(clientId) {
  const block = window.wp?.data
    ?.select?.('core/block-editor')
    ?.getBlock?.(clientId);
  if (!block) return '';
  const attrs = block.attributes || {};
  const value = attrs.content ?? attrs.text ?? attrs.value;
  return attrToPlainText(value).replace(/\s+/g, ' ').trim();
}

/**
 * If the user has a non-empty text-range selection inside the given block's
 * rich-text attribute, return just that substring. Otherwise return ''.
 * wp.data preserves the selection across toolbar/composer clicks so this works
 * after focus has left the editor surface.
 */
export function getBlockSelectionText(clientId) {
  const select = window.wp?.data?.select?.('core/block-editor');
  if (!select) return '';
  const start = select.getSelectionStart?.();
  const end = select.getSelectionEnd?.();
  if (!start || !end) return '';
  if (start.clientId !== clientId || end.clientId !== clientId) return '';
  if (start.attributeKey !== end.attributeKey) return '';
  if (start.offset == null || end.offset == null) return '';
  if (start.offset === end.offset) return '';

  const block = select.getBlock?.(clientId);
  const attrValue = block?.attributes?.[start.attributeKey];
  const text = attrToPlainText(attrValue);
  if (!text) return '';

  // Rich-text selection offsets index the plain text, not the source HTML.
  const from = Math.min(start.offset, end.offset);
  const to = Math.max(start.offset, end.offset);
  return text.slice(from, to).trim();
}

/**
 * Single-block "user has highlighted something" snapshot, or null. Returned
 * when there's exactly one selected text-bearing block AND a non-empty
 * text-range selection within it. Drives the composer chip + the inline
 * context we send to the model.
 */
export function getCurrentSelectionContext() {
  const select = window.wp?.data?.select?.('core/block-editor');
  if (!select) return null;
  const ids = select.getSelectedBlockClientIds?.() || [];
  if (ids.length !== 1) return null;
  const clientId = ids[0];
  const name = select.getBlockName?.(clientId);
  if (!name || !TEXT_BLOCKS.has(name)) return null;

  const selectedText = getBlockSelectionText(clientId);
  if (!selectedText) return null;

  return {
    clientId,
    blockName: name,
    blockLabel: blockLabel(name),
    selectedText,
  };
}
