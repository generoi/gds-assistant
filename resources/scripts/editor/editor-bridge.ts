/**
 * Bridge between the assistant and the live WordPress block editor.
 *
 * Reads the current selection and applies block edits directly to the unsaved
 * document via the editor's own `wp.data`/`wp.blocks` instances (using the
 * globals, not bundled copies, so we touch the SAME stores the editor uses).
 * v1 is blocks-only — whole-block read/replace/insert/attribute edits; inline
 * text-range edits are deferred.
 */

import { getCurrentSelectionContext } from "./selection";

// ── wp.* globals ────────────────────────────────────────────
// Narrow shapes for the bits we read off `window.wp.data` and `window.wp.blocks`.
// We type only what we touch; the editor stores are far larger than this. The
// editor uses *its* loaded instances of these modules, so we hit `window.wp`
// rather than importing — that way mutations land in the same stores the UI
// renders from.

interface SelectionPoint {
  clientId?: string;
  offset?: number;
  attributeKey?: string;
}

interface Block {
  clientId: string;
  name: string;
  attributes?: Record<string, unknown>;
  innerBlocks?: Block[];
  isValid?: boolean;
}

interface BlockEditorSelect {
  getSelectedBlockClientIds?: () => string[];
  getBlockName?: (clientId: string) => string | undefined;
  getBlock?: (clientId: string) => Block | undefined;
  getClientIdsWithDescendants?: () => string[];
  getBlockParents?: (clientId: string) => string[];
  getBlockRootClientId?: (clientId: string) => string | undefined;
  getBlockOrder?: (rootClientId: string) => string[];
  getSelectionStart?: () => SelectionPoint | undefined;
  getSelectionEnd?: () => SelectionPoint | undefined;
  getSettings?: () => {
    colors?: Array<{ slug: string; name?: string; color?: string }>;
    disableCustomColors?: boolean;
    __experimentalFeatures?: {
      color?: {
        palette?: {
          theme?: Array<{ slug: string; name?: string; color?: string }>;
        };
      };
    };
  };
}

interface EditorSelect {
  getCurrentPostId?: () => number | undefined;
  getCurrentPostType?: () => string | undefined;
  getEditedPostAttribute?: (key: string) => unknown;
}

interface EditPostSelect {
  getActiveGeneralSidebarName?: () => string | null;
}

interface BlockEditorDispatch {
  replaceBlocks: (clientIds: string[], blocks: Block[]) => void;
  insertBlocks: (
    blocks: Block[],
    index?: number,
    rootClientId?: string,
  ) => void;
  updateBlockAttributes: (
    clientId: string,
    attributes: Record<string, unknown>,
  ) => void;
  replaceBlock: (clientId: string, block: Block) => void;
}

interface EditorDispatch {
  editPost: (data: Record<string, unknown>) => void;
}

interface EditPostDispatch {
  openGeneralSidebar?: (name: string) => void;
}

interface CoreResolveSelect {
  getMedia?: (id: number) => Promise<MediaItem | undefined>;
}

interface MediaItem {
  id?: number;
  title?: { rendered?: string };
  slug?: string;
  source_url?: string;
  media_details?: { file?: string };
}

type StoreKey = "core" | "core/editor" | "core/block-editor" | "core/edit-post";

interface WpData {
  select: ((key: "core/block-editor") => BlockEditorSelect | undefined) &
    ((key: "core/editor") => EditorSelect | undefined) &
    ((key: "core/edit-post") => EditPostSelect | undefined) &
    ((key: StoreKey) => unknown);
  dispatch: ((key: "core/block-editor") => BlockEditorDispatch) &
    ((key: "core/editor") => EditorDispatch) &
    ((key: "core/edit-post") => EditPostDispatch | undefined) &
    ((key: StoreKey) => unknown);
  resolveSelect?: (key: "core") => CoreResolveSelect | undefined;
}

interface WpBlocks {
  parse: (markup: string) => Block[];
  serialize: (blocks: Block | Block[]) => string;
  createBlock: (
    name: string,
    attributes?: Record<string, unknown>,
    innerBlocks?: Block[],
  ) => Block;
  getBlockType?: (name: string) => { name: string } | undefined;
}

declare global {
  interface Window {
    wp?: {
      data?: WpData;
      blocks?: WpBlocks;
    };
  }
}

const wpData = (): WpData | undefined => window.wp?.data;
const wpBlocks = (): WpBlocks | undefined => window.wp?.blocks;

// ── Tool I/O ────────────────────────────────────────────────

/** All client-tool names dispatched in {@link executeClientTool}. */
export type EditorToolName =
  | "editor__read_selection"
  | "editor__replace_blocks"
  | "editor__insert_blocks"
  | "editor__update_block_attributes"
  | "editor__update_post"
  | "editor__recover_block"
  | "editor__query_dom"
  | "editor__focus"
  | "editor__open_sidebar";

/** Input shapes per tool (snake_case matches the server schema). */
export interface ReplaceBlocksInput {
  client_ids?: string[];
  markup?: string;
}
export interface InsertBlocksInput {
  markup?: string;
  after_client_id?: string;
}
export interface UpdateBlockAttributesInput {
  client_id?: string;
  attributes?: Record<string, unknown>;
}
export interface UpdatePostInput {
  title?: string;
  slug?: string;
  excerpt?: string;
  template?: string;
  featured_media?: number;
  author?: number;
  meta?: Record<string, unknown>;
}
export interface RecoverBlockInput {
  client_id?: string;
  client_ids?: string[];
}
export interface QueryDomInput {
  selector?: string;
  limit?: number;
}
export interface FocusInput {
  selector?: string;
}
export interface OpenSidebarInput {
  name?: string;
}

/** Generic input bag passed to {@link executeClientTool}. */
export type EditorToolInput =
  | ReplaceBlocksInput
  | InsertBlocksInput
  | UpdateBlockAttributesInput
  | UpdatePostInput
  | RecoverBlockInput
  | QueryDomInput
  | FocusInput
  | OpenSidebarInput
  | Record<string, never>;

/**
 * Before/after snapshot the tool-call card uses to render a real diff.
 * Captured for write tools before the change applies.
 */
export interface DiffSnapshot {
  kind: "replace" | "insert" | "attrs" | "post" | "recover";
  before: string;
  after: string;
  summary: string;
  clientId?: string;
}

/** Catch-all result shape — every tool either returns `{ error }` or `{ ok, ... }`. */
export interface EditorToolResult {
  error?: string;
  ok?: boolean;
  diff?: DiffSnapshot;
  [key: string]: unknown;
}

// Editor tools we capture a before-snapshot for, so the chat tool-call card
// can render a real unified diff after the change is applied. Read-only and
// DOM probe tools have no "before" to compare against.
const WRITE_TOOLS = new Set<EditorToolName>([
  "editor__replace_blocks",
  "editor__insert_blocks",
  "editor__update_block_attributes",
  "editor__update_post",
  "editor__recover_block",
]);

/** Is the block editor present and ready on this page? */
export function hasEditor(): boolean {
  const d = wpData();
  return !!(d?.select?.("core/block-editor") && d.select("core/editor"));
}

export interface EditorContext {
  has_editor: boolean;
  post_id?: number | null;
  post_type?: string | null;
  selected_block_count?: number;
  selected_block_types?: string[];
  has_text_selection?: boolean;
  selection_mode?: string | null;
  selected_text?: string | null;
  selected_block_text?: string | null;
  selected_block_label?: string | null;
  selected_block_client_id?: string | null;
  selected_block_labels?: string[] | null;
  selected_block_client_ids?: string[] | null;
  custom_colors?: boolean;
}

/**
 * Lightweight selection summary sent with each chat request so the model knows
 * what's open/selected without a round-trip. No block content — just shape.
 */
export function getEditorContext(): EditorContext {
  if (!hasEditor()) {
    return { has_editor: false };
  }
  const d = wpData();
  const ed = d?.select("core/editor");
  const be = d?.select("core/block-editor");

  const ids = be?.getSelectedBlockClientIds?.() || [];
  const types = ids
    .map((id) => be?.getBlockName?.(id))
    .filter((n): n is string => !!n);

  let hasText = false;
  try {
    const s = be?.getSelectionStart?.();
    const e = be?.getSelectionEnd?.();
    hasText = !!(
      s?.clientId &&
      s.clientId === e?.clientId &&
      s.offset !== e.offset
    );
  } catch {
    // selection store not ready — treat as no text selection
  }

  // What the user has selected right now — text range / whole block /
  // multi-block. The server prepends a short summary to the latest user
  // message body so the model has the snippet inline (avoids an
  // `editor__read_selection` round-trip on common "rewrite this" / "translate
  // this" prompts). Lives outside the system prompt to stay cache-friendly
  // across selection changes.
  const sel = getCurrentSelectionContext();
  const selectionPayload = {
    selection_mode: sel?.mode || null,
    selected_text: sel?.mode === "text-range" ? sel.selectedText : null,
    selected_block_text: sel?.mode === "whole-block" ? sel.blockText : null,
    selected_block_label:
      sel?.mode !== "multi-block" ? sel?.blockLabel || null : null,
    selected_block_client_id:
      sel?.mode !== "multi-block" ? sel?.clientId || null : null,
    selected_block_labels: sel?.mode === "multi-block" ? sel.blockLabels : null,
    selected_block_client_ids:
      sel?.mode === "multi-block" ? sel.clientIds : null,
  };

  return {
    has_editor: true,
    post_id: ed?.getCurrentPostId?.() || null,
    post_type: ed?.getCurrentPostType?.() || null,
    selected_block_count: ids.length,
    selected_block_types: types.slice(0, 20),
    has_text_selection: hasText,
    ...selectionPayload,
    // Derived from the theme (theme.json settings.color.custom) so the model
    // knows whether raw hex is allowed without us hardcoding it.
    custom_colors: !be?.getSettings?.()?.disableCustomColors,
  };
}

/**
 * Snapshot the relevant editor state BEFORE a write tool runs so the
 * tool-call card can show a real diff after it applies. We pull just enough
 * to make the diff meaningful — serialised markup for block writes, current
 * attribute values for attribute writes — not the full document.
 * @param toolName
 * @param input
 */
function snapshotBefore(
  toolName: EditorToolName,
  input: EditorToolInput,
): DiffSnapshot | null {
  const be = wpData()?.select?.("core/block-editor");
  const ed = wpData()?.select?.("core/editor");
  const blocks = wpBlocks();

  const blockText = (clientId: string): string => {
    const b = be?.getBlock?.(clientId);
    if (!b) {
      return "";
    }
    try {
      return blocks?.serialize?.([b]) || "";
    } catch {
      return "";
    }
  };

  // Schema-aligned field names: write tools take snake_case input
  // (client_ids, client_id, markup, after_client_id, attributes, etc.).
  switch (toolName) {
    case "editor__replace_blocks": {
      const i = input as ReplaceBlocksInput;
      const ids = Array.isArray(i.client_ids) ? i.client_ids : [];
      return {
        kind: "replace",
        before: ids.map(blockText).filter(Boolean).join("\n\n"),
        after: typeof i.markup === "string" ? i.markup : "",
        summary: `Replace ${ids.length} block${ids.length === 1 ? "" : "s"}`,
      };
    }
    case "editor__insert_blocks": {
      const i = input as InsertBlocksInput;
      const after = typeof i.markup === "string" ? i.markup : "";
      // Rough count by walking top-level block comments in the markup.
      const count = (after.match(/<!--\s*wp:/g) || []).length || 1;
      return {
        kind: "insert",
        before: "",
        after,
        summary: `Insert ${count} block${count === 1 ? "" : "s"}`,
      };
    }
    case "editor__update_block_attributes": {
      const i = input as UpdateBlockAttributesInput;
      const clientId = i.client_id;
      const block = clientId ? be?.getBlock?.(clientId) : null;
      const beforeAttrs = block?.attributes || {};
      const patch = i.attributes || {};
      const keys = Object.keys(patch);
      // RichTextValue objects don't stringify cleanly; expose `.text` so the
      // diff isn't a wall of "{}" placeholders.
      const norm = (v: unknown): unknown =>
        v &&
        typeof v === "object" &&
        "text" in v &&
        typeof (v as { text: unknown }).text === "string"
          ? (v as { text: string }).text
          : v;
      return {
        kind: "attrs",
        clientId,
        before: JSON.stringify(
          Object.fromEntries(keys.map((k) => [k, norm(beforeAttrs[k])])),
          null,
          2,
        ),
        after: JSON.stringify(
          Object.fromEntries(keys.map((k) => [k, norm(patch[k])])),
          null,
          2,
        ),
        summary: `Update ${keys.length} attribute${
          keys.length === 1 ? "" : "s"
        } on ${block?.name || "block"}`,
      };
    }
    case "editor__update_post": {
      const i = input as UpdatePostInput;
      const fields = [
        "title",
        "slug",
        "excerpt",
        "template",
        "featured_media",
        "author",
        "meta",
      ] as const;
      const current: Record<string, unknown> = {};
      for (const f of fields) {
        if (f in i) {
          current[f] = ed?.getEditedPostAttribute?.(f) ?? "";
        }
      }
      return {
        kind: "post",
        before: JSON.stringify(current, null, 2),
        after: JSON.stringify(i, null, 2),
        summary: "Update post fields",
      };
    }
    case "editor__recover_block": {
      const i = input as RecoverBlockInput;
      const ids = Array.isArray(i.client_ids) ? i.client_ids : [];
      return {
        kind: "recover",
        before: ids.map(blockText).filter(Boolean).join("\n\n"),
        after: "(re-parsed from existing attributes)",
        summary: `Recover ${ids.length} invalid block${
          ids.length === 1 ? "" : "s"
        }`,
      };
    }
    default:
      return null;
  }
}

/**
 * Run a client editor tool. Always resolves to a plain result object (never
 * throws) so it can be posted straight back to the loop.
 * @param toolName
 * @param input
 */
export async function executeClientTool(
  toolName: string,
  input: EditorToolInput = {},
): Promise<EditorToolResult> {
  if (!hasEditor()) {
    return { error: "No block editor is open on this page." };
  }

  // Capture a before-snapshot for write tools so the tool-call card can show
  // a real diff of what changed (post-apply, no approval gate). Reads + DOM
  // probes have nothing meaningful to diff.
  const snap = WRITE_TOOLS.has(toolName as EditorToolName)
    ? snapshotBefore(toolName as EditorToolName, input)
    : null;

  let result: EditorToolResult;
  try {
    switch (toolName) {
      case "editor__read_selection":
        result = await readSelection();
        break;
      case "editor__replace_blocks":
        result = replaceBlocks(input as ReplaceBlocksInput);
        break;
      case "editor__insert_blocks":
        result = insertBlocks(input as InsertBlocksInput);
        break;
      case "editor__update_block_attributes":
        result = updateBlockAttributes(input as UpdateBlockAttributesInput);
        break;
      case "editor__update_post":
        result = updatePost(input as UpdatePostInput);
        break;
      case "editor__recover_block":
        result = recoverBlock(input as RecoverBlockInput);
        break;
      case "editor__query_dom":
        result = queryDom(input as QueryDomInput);
        break;
      case "editor__focus":
        result = focusElement(input as FocusInput);
        break;
      case "editor__open_sidebar":
        result = openSidebar(input as OpenSidebarInput);
        break;
      default:
        return { error: `Unknown editor tool: ${toolName}` };
    }
  } catch (e) {
    return { error: String((e as Error)?.message || e) };
  }

  if (snap && result && typeof result === "object" && !result.error) {
    result.diff = snap;
  }
  return result;
}

// ── Ops ─────────────────────────────────────────────────────

function blockSnippet(block: Block): string {
  const a = (block?.attributes || {}) as Record<string, unknown>;
  const raw = a.content ?? a.text ?? a.title ?? a.label ?? a.value ?? "";
  const s = String(raw)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

// Compact copy of a block's attributes for the outline: truncate long strings,
// cap arrays, bound depth, drop the noisy srcset blob. Lets the model see what
// a non-text block holds (image url/alt, embed url, a logos id list, …) without
// dumping the whole document.
function compactAttributes(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 4) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 197)}…` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((v) => compactAttributes(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "sizes" || k === "srcSet") {
      continue;
    } // huge srcset data
    const c = compactAttributes(v, depth + 1);
    if (c !== undefined && c !== "") {
      out[k] = c;
    }
  }
  return out;
}

// Attribute keys that may hold attachment (media) ids worth resolving to a
// url/title so the model can identify an image by filename.
const MEDIA_KEY_RE =
  /(^id$|^ids$|image|images|media|logo|logos|gallery|thumbnail|poster|avatar|cover|backgroundimage)/i;

function collectMediaIds(
  attrs: unknown,
  out: number[] = [],
  depth = 0,
): number[] {
  if (!attrs || typeof attrs !== "object" || depth > 4) {
    return out;
  }
  const pushId = (x: unknown): void => {
    if (typeof x === "number" && Number.isInteger(x) && x > 0) {
      out.push(x);
    } else if (
      x &&
      typeof x === "object" &&
      "id" in x &&
      Number.isInteger((x as { id: unknown }).id)
    ) {
      out.push((x as { id: number }).id);
    }
  };
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (MEDIA_KEY_RE.test(k)) {
      if (Array.isArray(v)) {
        v.forEach(pushId);
      } else {
        pushId(v);
      }
    } else if (v && typeof v === "object") {
      collectMediaIds(v, out, depth + 1);
    }
  }
  return out;
}

interface ResolvedMedia {
  id: number;
  title: string;
  url: string;
  filename: string;
}

// Resolve attachment ids to {id, title, url, filename} via the editor's own
// `core` store (awaiting the resolver so it works even if not pre-fetched).
// Best-effort: ids that aren't attachments are silently skipped.
async function resolveMedia(
  ids: number[],
): Promise<Record<number, ResolvedMedia>> {
  const core = wpData()?.resolveSelect?.("core");
  if (!core?.getMedia) {
    return {};
  }
  const uniq = [...new Set(ids)].slice(0, 50);
  const out: Record<number, ResolvedMedia> = {};
  await Promise.all(
    uniq.map(async (id) => {
      try {
        const m = await core.getMedia!(id);
        if (!m) {
          return;
        }
        out[id] = {
          id,
          title: m.title?.rendered || m.slug || "",
          url: m.source_url || "",
          filename:
            m.media_details?.file ||
            (m.source_url || "").split("/").pop() ||
            "",
        };
      } catch {
        // not an attachment / not fetchable — skip
      }
    }),
  );
  return out;
}

interface OutlineEntry {
  client_id: string;
  name: string;
  depth: number;
  text: string;
  invalid?: boolean;
  unrecognized?: boolean;
  attributes?: unknown;
}

interface SelectedBlockEntry {
  client_id: string;
  name: string;
  markup: string;
}

interface TextSelectionInfo {
  client_id: string;
  attribute?: string;
  start?: number;
  end?: number;
}

interface ReadSelectionResult extends EditorToolResult {
  post: ReturnType<typeof postContext>;
  whole_document: boolean;
  has_text_selection: boolean;
  text_selection: TextSelectionInfo | null;
  selected_blocks: SelectedBlockEntry[];
  outline: OutlineEntry[];
  media: Record<number, ResolvedMedia>;
}

async function readSelection(): Promise<ReadSelectionResult> {
  const be = wpData()!.select("core/block-editor")!;
  const blocks = wpBlocks()!;

  const selectedIds = be.getSelectedBlockClientIds?.() || [];

  // Selected blocks get full markup (the model edits these directly).
  const selected: SelectedBlockEntry[] = selectedIds
    .map((id) => {
      const block = be.getBlock?.(id);
      return block
        ? {
            client_id: id,
            name: block.name,
            markup: blocks.serialize(block),
          }
        : null;
    })
    .filter((b): b is SelectedBlockEntry => b !== null);

  // A flat outline of EVERY block (including nested) so the model can target
  // any block by clientId — even nested ones, with nothing selected, or after
  // an edit changed ids — by matching on name + content rather than a cached
  // id. Text blocks carry a snippet; non-text blocks (images, galleries,
  // embeds, logo lists) carry their attributes so the model can see what's
  // inside instead of asking the user to select.
  const allIds = be.getClientIdsWithDescendants?.() || [];
  const mediaIds: number[] = [];
  const outline: OutlineEntry[] = allIds
    .map((id): OutlineEntry | null => {
      const block = be.getBlock?.(id);
      if (!block) {
        return null;
      }
      const text = blockSnippet(block);
      const entry: OutlineEntry = {
        client_id: id,
        name: block.name,
        depth: (be.getBlockParents?.(id) || []).length,
        text,
      };
      // Surface validation state so the model can find blocks the editor flags
      // as "unexpected or invalid content" and offer to recover them.
      if (block.isValid === false) {
        entry.invalid = true;
      }
      if (block.name === "core/missing") {
        entry.unrecognized = true;
      }
      if (!text) {
        const attrs = compactAttributes(block.attributes);
        if (attrs && typeof attrs === "object" && Object.keys(attrs).length) {
          entry.attributes = attrs;
        }
        collectMediaIds(block.attributes, mediaIds);
      }
      return entry;
    })
    .filter((e): e is OutlineEntry => e !== null);

  // Post-level context (status, slug, featured image, language + translations)
  // so the model can answer "what's the status / is there a Swedish version?".
  const post = postContext();
  if (post?.featured_media) {
    mediaIds.push(post.featured_media);
  }

  // Resolve referenced attachment ids so the model can match an image by its
  // filename/title (e.g. find the "snellman" logo) without a media tool.
  const media = mediaIds.length ? await resolveMedia(mediaIds) : {};

  let textSelection: TextSelectionInfo | null = null;
  try {
    const s = be.getSelectionStart!();
    const e = be.getSelectionEnd!();
    if (s?.clientId && s.clientId === e?.clientId && s.offset !== e.offset) {
      textSelection = {
        client_id: s.clientId,
        attribute: s.attributeKey,
        start: s.offset,
        end: e.offset,
      };
    }
  } catch {
    // ignore
  }

  return {
    // Post-level fields (status, slug, featured image, language, translations).
    post,
    whole_document: selectedIds.length === 0,
    has_text_selection: !!textSelection,
    text_selection: textSelection,
    selected_blocks: selected,
    outline,
    // Attachment id → {id, title, url, filename} for media referenced by the
    // outline blocks (and the featured image). Cross-reference an id in a
    // block's attributes (e.g. `logos`/`mediaId`) to identify the image by name.
    media,
  };
}

interface PostContext {
  id: number | undefined;
  type: string | undefined;
  status: unknown;
  slug: unknown;
  featured_media: number;
  template: string;
  language?: unknown;
  translations?: unknown;
}

// Post-level context read straight from core/editor — the unsaved edited
// values, so it reflects pending changes. language/translations come from
// Polylang via the standard attribute API (read-only data, no plugin coupling).
function postContext(): PostContext | null {
  const ed = wpData()?.select("core/editor");
  if (!ed?.getCurrentPostId) {
    return null;
  }
  const get = (k: string): unknown => {
    try {
      return ed.getEditedPostAttribute?.(k);
    } catch {
      return undefined;
    }
  };
  const ctx: PostContext = {
    id: ed.getCurrentPostId(),
    type: ed.getCurrentPostType?.(),
    status: get("status"),
    slug: get("slug"),
    featured_media: (get("featured_media") as number) || 0,
    template: (get("template") as string) || "",
  };
  const language = get("lang");
  if (language) {
    ctx.language = language;
  }
  const translations = get("translations");
  if (
    translations &&
    typeof translations === "object" &&
    Object.keys(translations).length
  ) {
    ctx.translations = translations;
  }
  return ctx;
}

interface ColorSettings {
  slugs: Set<string>;
  allowCustom: boolean;
}

// The editor's color palette + whether custom (hex) colors are allowed.
function colorSettings(): ColorSettings | null {
  try {
    const s = wpData()?.select("core/block-editor")?.getSettings?.();
    if (!s) {
      return null;
    }
    const colors =
      s.colors || s.__experimentalFeatures?.color?.palette?.theme || [];
    return {
      slugs: new Set(colors.map((c) => c.slug)),
      allowCustom: !s.disableCustomColors,
    };
  } catch {
    return null;
  }
}

// Find colour problems in a block's attributes: preset refs to unknown slugs,
// bare textColor/backgroundColor slugs that don't exist, and raw hex when the
// site disallows custom colours. Returns [] when we can't read the palette
// (don't block edits on uncertainty).
function colorIssues(attributes: unknown): string[] {
  const cfg = colorSettings();
  if (!cfg || !cfg.slugs.size) {
    return [];
  }

  const issues: string[] = [];
  const presetRe = /var:preset\|color\|([\w-]+)/;
  const hexRe = /#[0-9a-fA-F]{3,8}\b/;

  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      const p = v.match(presetRe);
      if (p && !cfg.slugs.has(p[1]!)) {
        issues.push(`unknown color slug "${p[1]}"`);
      }
      if (!cfg.allowCustom && hexRe.test(v)) {
        issues.push(
          `custom hex "${v.match(hexRe)![0]}" is disabled on this site`,
        );
      }
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(scan);
    }
  };
  const attrs = (attributes as Record<string, unknown>) || {};
  scan(attrs.style);

  for (const key of ["textColor", "backgroundColor", "overlayColor"] as const) {
    const val = attrs[key];
    if (typeof val === "string" && val && !cfg.slugs.has(val)) {
      issues.push(`unknown color slug "${val}" for ${key}`);
    }
  }

  return [...new Set(issues)];
}

function colorErrorHint(): string {
  const cfg = colorSettings();
  const examples = cfg ? [...cfg.slugs].slice(0, 8).join(", ") : "";
  const hex =
    cfg && !cfg.allowCustom ? " Custom hex is disabled on this site." : "";
  return `Use a palette slug from gds/design-theme-json (the "slug", not the display name) — e.g. ${examples}. Reference it as the textColor/backgroundColor attribute, or "var:preset|color|{slug}" in style.${hex}`;
}

interface ParseResult {
  parsed: Block[];
  issues: string[];
}

// Parse block markup and surface validation problems instead of silently
// applying a broken/unrecognized block (so the model can retry).
function parseValidated(markup: string | undefined): ParseResult {
  const parsed = wpBlocks()?.parse(markup || "") || [];
  const issues: string[] = [];
  const visit = (b: Block | undefined): void => {
    if (!b) {
      return;
    }
    if (b.name === "core/missing") {
      issues.push("unrecognized block in markup");
    } else if (b.isValid === false) {
      issues.push(`invalid content for ${b.name}`);
    }
    colorIssues(b.attributes).forEach((i) => issues.push(i));
    (b.innerBlocks || []).forEach(visit);
  };
  parsed.forEach(visit);
  return { parsed, issues: [...new Set(issues)] };
}

function replaceBlocks(input: ReplaceBlocksInput = {}): EditorToolResult {
  const ids = Array.isArray(input.client_ids) ? input.client_ids : [];
  const markup = input.markup;
  if (!ids.length) {
    return { error: "No client_ids provided to replace." };
  }

  // clientIds change after any edit. If the targets are gone, the dispatch is
  // a silent no-op — so fail loudly and tell the model to re-read.
  const be = wpData()!.select("core/block-editor")!;
  const missing = ids.filter((id) => !be.getBlock?.(id));
  if (missing.length) {
    return {
      error:
        "Target block(s) no longer exist — clientIds change after an edit. Call editor__read_selection again for current clientIds, then retry.",
      missing,
    };
  }

  const { parsed, issues } = parseValidated(markup);
  if (issues.length) {
    return { error: "Invalid block markup", issues };
  }
  if (!parsed.length) {
    return { error: "Markup produced no blocks." };
  }

  // parse() assigns clientIds and replaceBlocks inserts the blocks with them,
  // so these are the live ids of the new blocks. Return them so the model can
  // target follow-up edits without re-reading (old ids are now dead).
  const newIds = parsed.map((b) => b.clientId);
  wpData()!.dispatch("core/block-editor").replaceBlocks(ids, parsed);
  highlightChangedBlocks(newIds);
  return { ok: true, replaced: ids.length, new_client_ids: newIds };
}

function updatePost(input: UpdatePostInput = {}): EditorToolResult {
  const ed = wpData()!.select("core/editor")!;
  // Whitelist the core post fields we apply live (all unsaved + undoable via
  // the editor's history). Status/publish are intentionally excluded — those
  // are a save, not an editor-state edit.
  const allowed: Record<string, unknown> = {};
  for (const key of ["title", "slug", "excerpt", "template"] as const) {
    if (typeof input[key] === "string") {
      allowed[key] = input[key];
    }
  }
  // featured_media accepts 0 to clear; author is a user id.
  if (Number.isInteger(input.featured_media)) {
    allowed.featured_media = input.featured_media;
  }
  if (Number.isInteger(input.author)) {
    allowed.author = input.author;
  }
  // meta only reaches keys registered with show_in_rest (e.g. core post_color);
  // plugin data that isn't registered meta (Yoast, etc.) won't persist here.
  if (
    input.meta &&
    typeof input.meta === "object" &&
    !Array.isArray(input.meta)
  ) {
    allowed.meta = input.meta;
  }

  if (Object.keys(allowed).length === 0) {
    return {
      error:
        "Nothing to update (supported: title, slug, excerpt, template, featured_media, author, meta).",
    };
  }
  wpData()!.dispatch("core/editor").editPost(allowed);
  return {
    ok: true,
    updated: Object.keys(allowed),
    post_id: ed.getCurrentPostId?.() || null,
  };
}

function insertBlocks(input: InsertBlocksInput = {}): EditorToolResult {
  const { parsed, issues } = parseValidated(input.markup);
  if (issues.length) {
    return { error: "Invalid block markup", issues };
  }
  if (!parsed.length) {
    return { error: "Markup produced no blocks." };
  }

  const be = wpData()!.select("core/block-editor")!;
  const dispatch = wpData()!.dispatch("core/block-editor");
  const newIds = parsed.map((b) => b.clientId);
  const afterId = input.after_client_id;

  if (afterId) {
    const rootId = be.getBlockRootClientId?.(afterId) ?? "";
    const order = be.getBlockOrder?.(rootId) || [];
    const index = order.indexOf(afterId);
    dispatch.insertBlocks(parsed, index >= 0 ? index + 1 : undefined, rootId);
  } else {
    dispatch.insertBlocks(parsed);
  }
  highlightChangedBlocks(newIds);
  return { ok: true, inserted: parsed.length, new_client_ids: newIds };
}

function updateBlockAttributes(
  input: UpdateBlockAttributesInput = {},
): EditorToolResult {
  const clientId = input.client_id;
  const be = wpData()!.select("core/block-editor")!;
  if (!clientId || !be.getBlock?.(clientId)) {
    return { error: `Block ${clientId} not found.` };
  }

  // Catch unknown color slugs / disallowed hex before applying — otherwise the
  // editor stores a reference that resolves to nothing and the color silently
  // doesn't appear.
  const ci = colorIssues(input.attributes || {});
  if (ci.length) {
    return {
      error: `Color not applied: ${ci.join("; ")}. ${colorErrorHint()}`,
    };
  }

  wpData()!
    .dispatch("core/block-editor")
    .updateBlockAttributes(clientId, input.attributes || {});
  highlightChangedBlocks([clientId]);
  return { ok: true, client_id: clientId };
}

interface RecoveredEntry {
  client_id: string;
  new_client_id: string;
  name: string;
}

interface FailedEntry {
  client_id: string;
  reason: string;
}

// Recover invalid blocks the editor flags as "unexpected or invalid content":
// recreate each (and its whole subtree) from parsed attributes so save()
// regenerates valid markup — like the editor's "Attempt Block Recovery", but
// recursive so an invalid CHILD is fixed too. Undoable via the editor history.
// Unregistered blocks (core/missing) can't be recreated and are kept as-is.
function recoverBlock(input: RecoverBlockInput = {}): EditorToolResult {
  const ids = Array.isArray(input.client_ids)
    ? input.client_ids
    : input.client_id
    ? [input.client_id]
    : [];
  if (!ids.length) {
    return { error: "No client_ids provided to recover." };
  }

  const be = wpData()!.select("core/block-editor")!;
  const blocks = wpBlocks()!;
  const dispatch = wpData()!.dispatch("core/block-editor");

  const canRecreate = (b: Block | undefined | null): boolean =>
    !!b && b.name !== "core/missing" && !!blocks.getBlockType?.(b.name);
  // Rebuild a block from its attributes, recursing so invalid descendants are
  // fixed too; unregistered blocks are passed through untouched.
  const recreate = (b: Block): Block =>
    canRecreate(b)
      ? blocks.createBlock(
          b.name,
          b.attributes,
          (b.innerBlocks || []).map(recreate),
        )
      : b;
  const descendantIds = (b: Block, acc: string[] = []): string[] => {
    for (const c of b.innerBlocks || []) {
      acc.push(c.clientId);
      descendantIds(c, acc);
    }
    return acc;
  };

  // Ancestors first: recovering a block rebuilds its whole subtree (with new
  // clientIds), so a separately-requested descendant would no longer exist.
  // Track what each recovery covers and skip those.
  const ordered = [...new Set(ids)]
    .map((id) => ({ id, depth: (be.getBlockParents?.(id) || []).length }))
    .sort((a, b) => a.depth - b.depth);

  const recovered: RecoveredEntry[] = [];
  const failed: FailedEntry[] = [];
  const covered = new Set<string>();

  for (const { id } of ordered) {
    if (covered.has(id)) {
      continue;
    } // rebuilt as part of a recovered ancestor
    const block = be.getBlock?.(id);
    if (!block) {
      failed.push({
        client_id: id,
        reason: "no longer exists — re-read for current clientIds",
      });
      continue;
    }
    if (!canRecreate(block)) {
      const attrs = block.attributes as { originalName?: string } | undefined;
      const name = attrs?.originalName || block.name;
      failed.push({
        client_id: id,
        reason: `block type "${name}" is not registered — can't auto-recover; convert it to a Custom HTML block (editor__replace_blocks) instead`,
      });
      continue;
    }
    descendantIds(block).forEach((d) => covered.add(d));
    const fresh = recreate(block);
    dispatch.replaceBlock(id, fresh);
    // replaceBlock is a silent no-op on a stale id — confirm it landed.
    if (be.getBlock?.(fresh.clientId)) {
      recovered.push({
        client_id: id,
        new_client_id: fresh.clientId,
        name: block.name,
      });
    } else {
      failed.push({
        client_id: id,
        reason: "recovery did not apply — re-read and retry",
      });
    }
  }

  highlightChangedBlocks(recovered.map((r) => r.new_client_id));
  return { ok: failed.length === 0, recovered, failed };
}

// ── Generic DOM escape hatch (read + navigate only; never writes) ──
// These let the model work with editor UI the structured stores don't model —
// finding a setting, revealing a pane — without per-plugin code that breaks on
// updates. Mutations always go through the typed tools above.

function editorDocs(): Document[] {
  const docs: Document[] = [document];
  const cvs = document.querySelector<HTMLIFrameElement>(
    'iframe[name="editor-canvas"]',
  );
  if (cvs?.contentDocument) {
    docs.push(cvs.contentDocument);
  }
  return docs;
}

// ── Visual "we just changed this" cue ───────────────────────
// After each editor edit we briefly highlight the affected block(s) and scroll
// the first into view, so it's obvious what the assistant just touched.

const HIGHLIGHT_CSS = `
.gds-assistant-changed-block {
  animation: gds-assistant-block-flash 1.6s ease-out;
  border-radius: 4px;
}
@keyframes gds-assistant-block-flash {
  0% {
    box-shadow:
      0 0 0 2px rgba(255, 196, 0, 0.85),
      0 0 0 6px rgba(255, 196, 0, 0.25);
    background-color: rgba(255, 247, 196, 0.55);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 196, 0, 0);
    background-color: transparent;
  }
}`;

// Inject the flash CSS into every editor doc that needs it (top doc + canvas
// iframe). Cheap to call repeatedly — it skips docs that already have it.
function ensureHighlightStyles(): void {
  for (const doc of editorDocs()) {
    if (!doc.head || doc.head.querySelector("style[data-gds-highlight]")) {
      continue;
    }
    const style = doc.createElement("style");
    style.setAttribute("data-gds-highlight", "");
    style.textContent = HIGHLIGHT_CSS;
    doc.head.appendChild(style);
  }
}

/**
 * Briefly highlight the blocks with these clientIds and scroll the first one
 * into view. Silently no-ops if the block element isn't in the DOM yet.
 * @param clientIds
 */
function highlightChangedBlocks(clientIds: string[]): void {
  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return;
  }
  ensureHighlightStyles();
  // Defer one frame so React has a chance to mount any newly-inserted blocks
  // before we look them up by clientId.
  requestAnimationFrame(() => {
    let first: HTMLElement | null = null;
    for (const id of clientIds) {
      for (const doc of editorDocs()) {
        const el = doc.querySelector<HTMLElement>(`[data-block="${id}"]`);
        if (!el) {
          continue;
        }
        if (!first) {
          first = el;
        }
        // Restart the animation if the same block flashes back-to-back.
        el.classList.remove("gds-assistant-changed-block");
        // Force reflow so re-adding the class restarts the animation.
        void el.offsetWidth;
        el.classList.add("gds-assistant-changed-block");
        setTimeout(
          () => el.classList.remove("gds-assistant-changed-block"),
          1700,
        );
      }
    }
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

const capText = (v: unknown, n = 160): string | undefined =>
  v
    ? String(v).replace(/\s+/g, " ").trim().slice(0, n) || undefined
    : undefined;

interface DomElementSummary {
  tag: string;
  id?: string;
  class?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  aria_label?: string;
  role?: string;
  text?: string;
  value?: string;
  visible: boolean;
}

// Read-only: find elements by CSS selector so the model can locate settings,
// fields or panels (e.g. "where is this setting?"). Searches the editor canvas
// iframe too. Never writes.
function queryDom(input: QueryDomInput = {}): EditorToolResult {
  const selector = input.selector;
  if (!selector) {
    return { error: "Provide a CSS selector." };
  }
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);

  const out: DomElementSummary[] = [];
  for (const doc of editorDocs()) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (e) {
      return { error: `Invalid selector: ${(e as Error).message}` };
    }
    for (const el of Array.from(nodes)) {
      if (out.length >= limit) {
        break;
      }
      const r = el.getBoundingClientRect();
      const inputEl = el as HTMLInputElement;
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        class:
          typeof el.className === "string"
            ? capText(el.className, 120)
            : undefined,
        name: el.getAttribute?.("name") || undefined,
        type: el.getAttribute?.("type") || undefined,
        placeholder: el.getAttribute?.("placeholder") || undefined,
        aria_label: el.getAttribute?.("aria-label") || undefined,
        role: el.getAttribute?.("role") || undefined,
        text: capText(el.textContent),
        value: "value" in el ? capText(inputEl.value) : undefined,
        visible: !!(r.width || r.height),
      });
    }
  }
  return { selector, count: out.length, elements: out };
}

// Scroll the first matching element into view and focus it — e.g. to show the
// user where a setting lives. No click, no value change.
function focusElement(input: FocusInput = {}): EditorToolResult {
  const selector = input.selector;
  if (!selector) {
    return { error: "Provide a CSS selector." };
  }
  let el: HTMLElement | null = null;
  for (const doc of editorDocs()) {
    try {
      el = doc.querySelector<HTMLElement>(selector);
    } catch (e) {
      return { error: `Invalid selector: ${(e as Error).message}` };
    }
    if (el) {
      break;
    }
  }
  if (!el) {
    return { error: `No element matches ${selector}.` };
  }
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
  try {
    el.focus?.({ preventScroll: true });
  } catch {
    // not focusable — scrolling into view is enough
  }
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: capText(el.textContent, 120),
  };
}

interface SidebarEntry {
  name: string;
  label: string;
  active: boolean;
}

// Enumerate the side panels actually registered on THIS site. The pane toggle
// buttons expose their openable id as aria-controls in "scope:name" form
// (e.g. "yoast-seo:seo-sidebar"); openGeneralSidebar wants "scope/name". Read
// them from the DOM rather than guessing names that may not exist.
function listSidebars(): SidebarEntry[] {
  const seen = new Map<string, SidebarEntry>();
  for (const doc of editorDocs()) {
    for (const btn of Array.from(
      doc.querySelectorAll("button[aria-controls]"),
    )) {
      const ctrl = btn.getAttribute("aria-controls") || "";
      if (!/^[\w-]+:[\w-]+$/.test(ctrl)) {
        continue;
      } // not a sidebar id
      const name = ctrl.replace(":", "/");
      if (seen.has(name)) {
        continue;
      }
      seen.set(name, {
        name,
        label:
          btn.getAttribute("aria-label") || capText(btn.textContent) || name,
        active: btn.getAttribute("aria-pressed") === "true",
      });
    }
  }
  return [...seen.values()];
}

// List or open the editor's side panels. With no name, returns the sidebars
// registered on this site (name + label + active) so the model picks a real
// one. With a name, validates it against that list before opening — so we never
// "open" a phantom panel. No click, no content change.
function openSidebar(input: OpenSidebarInput = {}): EditorToolResult {
  const available = listSidebars();
  const name = String(input.name || "").trim();
  if (!name) {
    return { available };
  }

  const match = available.find((s) => s.name === name);
  if (!match) {
    return { error: `No sidebar "${name}" is registered here.`, available };
  }
  const d =
    wpData()?.dispatch("core/edit-post") || wpData()?.dispatch("core/editor");
  const sel =
    wpData()?.select("core/edit-post") || wpData()?.select("core/editor");
  if (!d || !("openGeneralSidebar" in d) || !d.openGeneralSidebar) {
    return { error: "Sidebar control is unavailable in this editor." };
  }
  d.openGeneralSidebar(name);
  return {
    ok: true,
    opened: name,
    label: match.label,
    active:
      sel && "getActiveGeneralSidebarName" in sel
        ? sel.getActiveGeneralSidebarName?.() ?? null
        : null,
  };
}
