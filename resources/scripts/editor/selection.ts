/**
 * Shared selection helpers for the live block editor.
 *
 * Used by both the block-toolbar dropdown and the chat composer chip. Keeps a
 * single source of truth for how we read text + selection out of `wp.data`,
 * and runtime-branches on the block-attribute shape (HTML string in
 * WP 6.5–6.x, RichTextValue object in WP 7.0+) so both versions work without
 * a hard `Requires at least` floor higher than 6.5.
 */

// ── wp.* surface used here ──────────────────────────────────
// Local types for the narrow `window.wp` API this module touches. The shape
// is read via a `window as { wp?: ... }` cast at the call site rather than
// `declare global` so we don't race with editor-bridge.ts's own
// (intentionally different) `wp.data` overloads.

interface SelectionPoint {
  clientId?: string;
  offset?: number;
  attributeKey?: string;
}

interface Block {
  clientId: string;
  name: string;
  attributes?: Record<string, unknown>;
}

interface BlockEditorSelect {
  getSelectedBlockClientIds?: () => string[];
  getBlockName?: (clientId: string) => string | undefined;
  getBlock?: (clientId: string) => Block | undefined;
  getSelectionStart?: () => SelectionPoint | undefined;
  getSelectionEnd?: () => SelectionPoint | undefined;
}

interface RichTextValue {
  text?: string;
}

interface WpSurface {
  data?: {
    select?: (key: "core/block-editor") => BlockEditorSelect | undefined;
  };
  richText?: {
    create?: (opts: { html: string }) => RichTextValue | undefined;
  };
}

function wp(): WpSurface | undefined {
  return (window as unknown as { wp?: WpSurface }).wp;
}

/** Blocks where text-range selection is meaningful. */
export const TEXT_BLOCKS = new Set<string>([
  "core/paragraph",
  "core/heading",
  "core/list",
  "core/list-item",
  "core/quote",
  "core/pullquote",
  "core/preformatted",
  "core/verse",
]);

/**
 * Friendly block label for human-facing strings ("core/paragraph" → "paragraph").
 * @param name
 */
export function blockLabel(name: string | undefined): string {
  return (name || "").replace(/^core\//, "").replace(/-/g, " ");
}

/**
 * Strip HTML + collapse whitespace from a string.
 * @param value
 */
export function stripHtml(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Block rich-text attributes can be one of two shapes depending on WP version:
 *  - an HTML string (legacy)
 *  - a RichTextValue object with `.text` + `.formats` (WP 7.0+)
 * Normalise both to plain text.
 * @param attrValue
 */
export function attrToPlainText(attrValue: unknown): string {
  if (typeof attrValue === "string") {
    const rich = wp()?.richText?.create?.({ html: attrValue });
    if (typeof rich?.text === "string") {
      return rich.text;
    }
    return stripHtml(attrValue);
  }
  if (
    attrValue &&
    typeof attrValue === "object" &&
    "text" in attrValue &&
    typeof (attrValue as { text: unknown }).text === "string"
  ) {
    return (attrValue as { text: string }).text;
  }
  return "";
}

/**
 * Plain text of a block's primary content attribute, collapsed + trimmed.
 * @param clientId
 */
export function getBlockText(clientId: string): string {
  const block = wp()?.data?.select?.("core/block-editor")?.getBlock?.(clientId);
  if (!block) {
    return "";
  }
  const attrs = block.attributes || {};
  const value = attrs.content ?? attrs.text ?? attrs.value;
  return attrToPlainText(value).replace(/\s+/g, " ").trim();
}

/**
 * If the user has a non-empty text-range selection inside the given block's
 * rich-text attribute, return just that substring. Otherwise return ''.
 * wp.data preserves the selection across toolbar/composer clicks so this works
 * after focus has left the editor surface.
 * @param clientId
 */
export function getBlockSelectionText(clientId: string): string {
  const select = wp()?.data?.select?.("core/block-editor");
  if (!select) {
    return "";
  }
  const start = select.getSelectionStart?.();
  const end = select.getSelectionEnd?.();
  if (!start || !end) {
    return "";
  }
  if (start.clientId !== clientId || end.clientId !== clientId) {
    return "";
  }
  if (start.attributeKey !== end.attributeKey) {
    return "";
  }
  if (start.offset === undefined || end.offset === undefined) {
    return "";
  }
  if (start.offset === end.offset) {
    return "";
  }

  const block = select.getBlock?.(clientId);
  const attrValue = start.attributeKey
    ? block?.attributes?.[start.attributeKey]
    : undefined;
  const text = attrToPlainText(attrValue);
  if (!text) {
    return "";
  }

  // Rich-text selection offsets index the plain text, not the source HTML.
  const from = Math.min(start.offset, end.offset);
  const to = Math.max(start.offset, end.offset);
  return text.slice(from, to).trim();
}

/**
 * Snapshot of what the user has selected in the editor right now, or null when
 * nothing is selected. Three shapes (discriminated on `mode`):
 *
 *   {mode: 'text-range', …}   single text-bearing block with a range
 *   {mode: 'whole-block', …}  single block with no range
 *   {mode: 'multi-block', …}  multiple blocks selected at once
 */
export interface TextRangeSelection {
  mode: "text-range";
  clientId: string;
  blockName: string;
  blockLabel: string;
  selectedText: string;
  blockText: string;
}

export interface WholeBlockSelection {
  mode: "whole-block";
  clientId: string;
  blockName: string;
  blockLabel: string;
  blockText: string;
}

export interface MultiBlockSelection {
  mode: "multi-block";
  count: number;
  clientIds: string[];
  blockNames: string[];
  blockLabels: string[];
}

export type SelectionContext =
  | TextRangeSelection
  | WholeBlockSelection
  | MultiBlockSelection;

export function getCurrentSelectionContext(): SelectionContext | null {
  const select = wp()?.data?.select?.("core/block-editor");
  if (!select) {
    return null;
  }
  const ids = select.getSelectedBlockClientIds?.() || [];
  if (!ids.length) {
    return null;
  }

  if (ids.length > 1) {
    const names = ids
      .map((id) => select.getBlockName?.(id))
      .filter((n): n is string => !!n);
    if (!names.length) {
      return null;
    }
    return {
      mode: "multi-block",
      count: ids.length,
      clientIds: ids,
      blockNames: names,
      blockLabels: names.map((n) => blockLabel(n)),
    };
  }

  const clientId = ids[0]!;
  const name = select.getBlockName?.(clientId);
  if (!name) {
    return null;
  }
  const label = blockLabel(name);

  // Text-range mode requires the block to be text-bearing AND have a non-empty
  // range. Anything else falls through to whole-block.
  if (TEXT_BLOCKS.has(name)) {
    const selectedText = getBlockSelectionText(clientId);
    if (selectedText) {
      return {
        mode: "text-range",
        clientId,
        blockName: name,
        blockLabel: label,
        selectedText,
        blockText: getBlockText(clientId),
      };
    }
  }

  // Whole-block (text-bearing without a range, or any non-text block).
  return {
    mode: "whole-block",
    clientId,
    blockName: name,
    blockLabel: label,
    blockText: TEXT_BLOCKS.has(name) ? getBlockText(clientId) : "",
  };
}
