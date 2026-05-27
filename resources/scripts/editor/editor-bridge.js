/**
 * Bridge between the assistant and the live WordPress block editor.
 *
 * Reads the current selection and applies block edits directly to the unsaved
 * document via the editor's own `wp.data`/`wp.blocks` instances (using the
 * globals, not bundled copies, so we touch the SAME stores the editor uses).
 * v1 is blocks-only — whole-block read/replace/insert/attribute edits; inline
 * text-range edits are deferred.
 */

const wpData = () => window.wp?.data;
const wpBlocks = () => window.wp?.blocks;

/** Is the block editor present and ready on this page? */
export function hasEditor() {
  const d = wpData();
  return !!(d?.select?.('core/block-editor') && d.select('core/editor'));
}

/**
 * Lightweight selection summary sent with each chat request so the model knows
 * what's open/selected without a round-trip. No block content — just shape.
 */
export function getEditorContext() {
  if (!hasEditor()) return {has_editor: false};
  const d = wpData();
  const ed = d.select('core/editor');
  const be = d.select('core/block-editor');

  const ids = be.getSelectedBlockClientIds?.() || [];
  const types = ids.map((id) => be.getBlockName?.(id)).filter(Boolean);

  let hasText = false;
  try {
    const s = be.getSelectionStart?.();
    const e = be.getSelectionEnd?.();
    hasText = !!(
      s?.clientId &&
      s.clientId === e?.clientId &&
      s.offset !== e.offset
    );
  } catch {
    // selection store not ready — treat as no text selection
  }

  return {
    has_editor: true,
    post_id: ed.getCurrentPostId?.() || null,
    post_type: ed.getCurrentPostType?.() || null,
    selected_block_count: ids.length,
    selected_block_types: types.slice(0, 20),
    has_text_selection: hasText,
    // Derived from the theme (theme.json settings.color.custom) so the model
    // knows whether raw hex is allowed without us hardcoding it.
    custom_colors: !be.getSettings?.()?.disableCustomColors,
  };
}

/**
 * Run a client editor tool. Always resolves to a plain result object (never
 * throws) so it can be posted straight back to the loop.
 *
 * @param {string} toolName Editor tool name (editor__*).
 * @param {Object} input    Tool input from the model.
 * @return {Promise<Object>} Result object (or {error}).
 */
export async function executeClientTool(toolName, input = {}) {
  if (!hasEditor()) {
    return {error: 'No block editor is open on this page.'};
  }
  try {
    switch (toolName) {
      case 'editor__read_selection':
        return await readSelection();
      case 'editor__replace_blocks':
        return replaceBlocks(input);
      case 'editor__insert_blocks':
        return insertBlocks(input);
      case 'editor__update_block_attributes':
        return updateBlockAttributes(input);
      case 'editor__update_post':
        return updatePost(input);
      case 'editor__recover_block':
        return recoverBlock(input);
      case 'editor__query_dom':
        return queryDom(input);
      case 'editor__focus':
        return focusElement(input);
      case 'editor__open_sidebar':
        return openSidebar(input);
      default:
        return {error: `Unknown editor tool: ${toolName}`};
    }
  } catch (e) {
    return {error: String(e?.message || e)};
  }
}

// ── Ops ─────────────────────────────────────────────────────

function blockSnippet(block) {
  const a = block?.attributes || {};
  const raw = a.content ?? a.text ?? a.title ?? a.label ?? a.value ?? '';
  const s = String(raw)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

// Compact copy of a block's attributes for the outline: truncate long strings,
// cap arrays, bound depth, drop the noisy srcset blob. Lets the model see what
// a non-text block holds (image url/alt, embed url, a logos id list, …) without
// dumping the whole document.
function compactAttributes(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return undefined;
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 197)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((v) => compactAttributes(v, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'sizes' || k === 'srcSet') continue; // huge srcset data
    const c = compactAttributes(v, depth + 1);
    if (c !== undefined && c !== '') out[k] = c;
  }
  return out;
}

// Attribute keys that may hold attachment (media) ids worth resolving to a
// url/title so the model can identify an image by filename.
const MEDIA_KEY_RE =
  /(^id$|^ids$|image|images|media|logo|logos|gallery|thumbnail|poster|avatar|cover|backgroundimage)/i;

function collectMediaIds(attrs, out = [], depth = 0) {
  if (!attrs || typeof attrs !== 'object' || depth > 4) return out;
  const pushId = (x) => {
    if (typeof x === 'number' && Number.isInteger(x) && x > 0) out.push(x);
    else if (x && typeof x === 'object' && Number.isInteger(x.id))
      out.push(x.id);
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (MEDIA_KEY_RE.test(k)) {
      if (Array.isArray(v)) v.forEach(pushId);
      else pushId(v);
    } else if (v && typeof v === 'object') {
      collectMediaIds(v, out, depth + 1);
    }
  }
  return out;
}

// Resolve attachment ids to {id, title, url, filename} via the editor's own
// `core` store (awaiting the resolver so it works even if not pre-fetched).
// Best-effort: ids that aren't attachments are silently skipped.
async function resolveMedia(ids) {
  const core = wpData().resolveSelect?.('core');
  if (!core?.getMedia) return {};
  const uniq = [...new Set(ids)].slice(0, 50);
  const out = {};
  await Promise.all(
    uniq.map(async (id) => {
      try {
        const m = await core.getMedia(id);
        if (!m) return;
        out[id] = {
          id,
          title: m.title?.rendered || m.slug || '',
          url: m.source_url || '',
          filename:
            m.media_details?.file || (m.source_url || '').split('/').pop(),
        };
      } catch {
        // not an attachment / not fetchable — skip
      }
    }),
  );
  return out;
}

async function readSelection() {
  const be = wpData().select('core/block-editor');
  const blocks = wpBlocks();

  const selectedIds = be.getSelectedBlockClientIds?.() || [];

  // Selected blocks get full markup (the model edits these directly).
  const selected = selectedIds
    .map((id) => {
      const block = be.getBlock?.(id);
      return block ?
          {client_id: id, name: block.name, markup: blocks.serialize(block)}
        : null;
    })
    .filter(Boolean);

  // A flat outline of EVERY block (including nested) so the model can target
  // any block by clientId — even nested ones, with nothing selected, or after
  // an edit changed ids — by matching on name + content rather than a cached
  // id. Text blocks carry a snippet; non-text blocks (images, galleries,
  // embeds, logo lists) carry their attributes so the model can see what's
  // inside instead of asking the user to select.
  const allIds = be.getClientIdsWithDescendants?.() || [];
  const mediaIds = [];
  const outline = allIds
    .map((id) => {
      const block = be.getBlock?.(id);
      if (!block) return null;
      const text = blockSnippet(block);
      const entry = {
        client_id: id,
        name: block.name,
        depth: (be.getBlockParents?.(id) || []).length,
        text,
      };
      // Surface validation state so the model can find blocks the editor flags
      // as "unexpected or invalid content" and offer to recover them.
      if (block.isValid === false) entry.invalid = true;
      if (block.name === 'core/missing') entry.unrecognized = true;
      if (!text) {
        const attrs = compactAttributes(block.attributes);
        if (attrs && Object.keys(attrs).length) entry.attributes = attrs;
        collectMediaIds(block.attributes, mediaIds);
      }
      return entry;
    })
    .filter(Boolean);

  // Resolve referenced attachment ids so the model can match an image by its
  // filename/title (e.g. find the "snellman" logo) without a media tool.
  const media = mediaIds.length ? await resolveMedia(mediaIds) : {};

  let textSelection = null;
  try {
    const s = be.getSelectionStart();
    const e = be.getSelectionEnd();
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
    whole_document: selectedIds.length === 0,
    has_text_selection: !!textSelection,
    text_selection: textSelection,
    selected_blocks: selected,
    outline,
    // Attachment id → {id, title, url, filename} for media referenced by the
    // outline blocks. Cross-reference an id in a block's attributes (e.g.
    // `logos`/`mediaId`) to identify the image by name.
    media,
  };
}

// The editor's color palette + whether custom (hex) colors are allowed.
function colorSettings() {
  try {
    const s = wpData().select('core/block-editor').getSettings();
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
function colorIssues(attributes) {
  const cfg = colorSettings();
  if (!cfg || !cfg.slugs.size) return [];

  const issues = [];
  const presetRe = /var:preset\|color\|([\w-]+)/;
  const hexRe = /#[0-9a-fA-F]{3,8}\b/;

  const scan = (v) => {
    if (typeof v === 'string') {
      const p = v.match(presetRe);
      if (p && !cfg.slugs.has(p[1])) {
        issues.push(`unknown color slug "${p[1]}"`);
      }
      if (!cfg.allowCustom && hexRe.test(v)) {
        issues.push(
          `custom hex "${v.match(hexRe)[0]}" is disabled on this site`,
        );
      }
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(scan);
    }
  };
  scan(attributes?.style);

  for (const key of ['textColor', 'backgroundColor', 'overlayColor']) {
    const val = attributes?.[key];
    if (typeof val === 'string' && val && !cfg.slugs.has(val)) {
      issues.push(`unknown color slug "${val}" for ${key}`);
    }
  }

  return [...new Set(issues)];
}

function colorErrorHint() {
  const cfg = colorSettings();
  const examples = cfg ? [...cfg.slugs].slice(0, 8).join(', ') : '';
  const hex =
    cfg && !cfg.allowCustom ? ' Custom hex is disabled on this site.' : '';
  return `Use a palette slug from gds/design-theme-json (the "slug", not the display name) — e.g. ${examples}. Reference it as the textColor/backgroundColor attribute, or "var:preset|color|{slug}" in style.${hex}`;
}

// Parse block markup and surface validation problems instead of silently
// applying a broken/unrecognized block (so the model can retry).
function parseValidated(markup) {
  const parsed = wpBlocks().parse(markup || '');
  const issues = [];
  const visit = (b) => {
    if (!b) return;
    if (b.name === 'core/missing') {
      issues.push('unrecognized block in markup');
    } else if (b.isValid === false) {
      issues.push(`invalid content for ${b.name}`);
    }
    colorIssues(b.attributes).forEach((i) => issues.push(i));
    (b.innerBlocks || []).forEach(visit);
  };
  parsed.forEach(visit);
  return {parsed, issues: [...new Set(issues)]};
}

function replaceBlocks(input = {}) {
  const ids = Array.isArray(input.client_ids) ? input.client_ids : [];
  const markup = input.markup;
  if (!ids.length) return {error: 'No client_ids provided to replace.'};

  // clientIds change after any edit. If the targets are gone, the dispatch is
  // a silent no-op — so fail loudly and tell the model to re-read.
  const be = wpData().select('core/block-editor');
  const missing = ids.filter((id) => !be.getBlock?.(id));
  if (missing.length) {
    return {
      error:
        'Target block(s) no longer exist — clientIds change after an edit. Call editor__read_selection again for current clientIds, then retry.',
      missing,
    };
  }

  const {parsed, issues} = parseValidated(markup);
  if (issues.length) return {error: 'Invalid block markup', issues};
  if (!parsed.length) return {error: 'Markup produced no blocks.'};

  // parse() assigns clientIds and replaceBlocks inserts the blocks with them,
  // so these are the live ids of the new blocks. Return them so the model can
  // target follow-up edits without re-reading (old ids are now dead).
  const newIds = parsed.map((b) => b.clientId);
  wpData().dispatch('core/block-editor').replaceBlocks(ids, parsed);
  return {ok: true, replaced: ids.length, new_client_ids: newIds};
}

function updatePost(input = {}) {
  const ed = wpData().select('core/editor');
  // Whitelist the fields we apply live (all undoable via the editor's history).
  const allowed = {};
  if (typeof input.title === 'string') allowed.title = input.title;
  if (Object.keys(allowed).length === 0) {
    return {error: 'Nothing to update (supported: title).'};
  }
  wpData().dispatch('core/editor').editPost(allowed);
  return {
    ok: true,
    updated: Object.keys(allowed),
    post_id: ed.getCurrentPostId?.() || null,
  };
}

function insertBlocks(input = {}) {
  const {parsed, issues} = parseValidated(input.markup);
  if (issues.length) return {error: 'Invalid block markup', issues};
  if (!parsed.length) return {error: 'Markup produced no blocks.'};

  const be = wpData().select('core/block-editor');
  const dispatch = wpData().dispatch('core/block-editor');
  const newIds = parsed.map((b) => b.clientId);
  const afterId = input.after_client_id;

  if (afterId) {
    const rootId = be.getBlockRootClientId?.(afterId) ?? '';
    const order = be.getBlockOrder?.(rootId) || [];
    const index = order.indexOf(afterId);
    dispatch.insertBlocks(parsed, index >= 0 ? index + 1 : undefined, rootId);
  } else {
    dispatch.insertBlocks(parsed);
  }
  return {ok: true, inserted: parsed.length, new_client_ids: newIds};
}

function updateBlockAttributes(input = {}) {
  const clientId = input.client_id;
  const be = wpData().select('core/block-editor');
  if (!clientId || !be.getBlock?.(clientId)) {
    return {error: `Block ${clientId} not found.`};
  }

  // Catch unknown color slugs / disallowed hex before applying — otherwise the
  // editor stores a reference that resolves to nothing and the color silently
  // doesn't appear.
  const ci = colorIssues(input.attributes || {});
  if (ci.length) {
    return {error: `Color not applied: ${ci.join('; ')}. ${colorErrorHint()}`};
  }

  wpData()
    .dispatch('core/block-editor')
    .updateBlockAttributes(clientId, input.attributes || {});
  return {ok: true, client_id: clientId};
}

// Recover invalid blocks the editor flags as "unexpected or invalid content":
// recreate each (and its whole subtree) from parsed attributes so save()
// regenerates valid markup — like the editor's "Attempt Block Recovery", but
// recursive so an invalid CHILD is fixed too. Undoable via the editor history.
// Unregistered blocks (core/missing) can't be recreated and are kept as-is.
function recoverBlock(input = {}) {
  const ids =
    Array.isArray(input.client_ids) ? input.client_ids
    : input.client_id ? [input.client_id]
    : [];
  if (!ids.length) return {error: 'No client_ids provided to recover.'};

  const be = wpData().select('core/block-editor');
  const blocks = wpBlocks();
  const dispatch = wpData().dispatch('core/block-editor');

  const canRecreate = (b) =>
    !!b && b.name !== 'core/missing' && !!blocks.getBlockType?.(b.name);
  // Rebuild a block from its attributes, recursing so invalid descendants are
  // fixed too; unregistered blocks are passed through untouched.
  const recreate = (b) =>
    canRecreate(b) ?
      blocks.createBlock(
        b.name,
        b.attributes,
        (b.innerBlocks || []).map(recreate),
      )
    : b;
  const descendantIds = (b, acc = []) => {
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
    .map((id) => ({id, depth: (be.getBlockParents?.(id) || []).length}))
    .sort((a, b) => a.depth - b.depth);

  const recovered = [];
  const failed = [];
  const covered = new Set();

  for (const {id} of ordered) {
    if (covered.has(id)) continue; // rebuilt as part of a recovered ancestor
    const block = be.getBlock?.(id);
    if (!block) {
      failed.push({
        client_id: id,
        reason: 'no longer exists — re-read for current clientIds',
      });
      continue;
    }
    if (!canRecreate(block)) {
      const name = block.attributes?.originalName || block.name;
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
        reason: 'recovery did not apply — re-read and retry',
      });
    }
  }

  return {ok: failed.length === 0, recovered, failed};
}

// ── Generic DOM escape hatch (read + navigate only; never writes) ──
// These let the model work with editor UI the structured stores don't model —
// finding a setting, revealing a pane — without per-plugin code that breaks on
// updates. Mutations always go through the typed tools above.

function editorDocs() {
  const docs = [document];
  const cvs = document.querySelector('iframe[name="editor-canvas"]');
  if (cvs?.contentDocument) docs.push(cvs.contentDocument);
  return docs;
}

const capText = (v, n = 160) =>
  v ?
    String(v).replace(/\s+/g, ' ').trim().slice(0, n) || undefined
  : undefined;

// Read-only: find elements by CSS selector so the model can locate settings,
// fields or panels (e.g. "where is this setting?"). Searches the editor canvas
// iframe too. Never writes.
function queryDom(input = {}) {
  const selector = input.selector;
  if (!selector) return {error: 'Provide a CSS selector.'};
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);

  const out = [];
  for (const doc of editorDocs()) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (e) {
      return {error: `Invalid selector: ${e.message}`};
    }
    for (const el of nodes) {
      if (out.length >= limit) break;
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        class:
          typeof el.className === 'string' ?
            capText(el.className, 120)
          : undefined,
        name: el.getAttribute?.('name') || undefined,
        type: el.getAttribute?.('type') || undefined,
        placeholder: el.getAttribute?.('placeholder') || undefined,
        aria_label: el.getAttribute?.('aria-label') || undefined,
        role: el.getAttribute?.('role') || undefined,
        text: capText(el.textContent),
        value: 'value' in el ? capText(el.value) : undefined,
        visible: !!(r.width || r.height),
      });
    }
  }
  return {selector, count: out.length, elements: out};
}

// Scroll the first matching element into view and focus it — e.g. to show the
// user where a setting lives. No click, no value change.
function focusElement(input = {}) {
  const selector = input.selector;
  if (!selector) return {error: 'Provide a CSS selector.'};
  let el = null;
  for (const doc of editorDocs()) {
    try {
      el = doc.querySelector(selector);
    } catch (e) {
      return {error: `Invalid selector: ${e.message}`};
    }
    if (el) break;
  }
  if (!el) return {error: `No element matches ${selector}.`};
  el.scrollIntoView?.({behavior: 'smooth', block: 'center'});
  try {
    el.focus?.({preventScroll: true});
  } catch {
    // not focusable — scrolling into view is enough
  }
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: capText(el.textContent, 120),
  };
}

// Enumerate the side panels actually registered on THIS site. The pane toggle
// buttons expose their openable id as aria-controls in "scope:name" form
// (e.g. "yoast-seo:seo-sidebar"); openGeneralSidebar wants "scope/name". Read
// them from the DOM rather than guessing names that may not exist.
function listSidebars() {
  const seen = new Map();
  for (const doc of editorDocs()) {
    for (const btn of doc.querySelectorAll('button[aria-controls]')) {
      const ctrl = btn.getAttribute('aria-controls') || '';
      if (!/^[\w-]+:[\w-]+$/.test(ctrl)) continue; // not a sidebar id
      const name = ctrl.replace(':', '/');
      if (seen.has(name)) continue;
      seen.set(name, {
        name,
        label:
          btn.getAttribute('aria-label') || capText(btn.textContent) || name,
        active: btn.getAttribute('aria-pressed') === 'true',
      });
    }
  }
  return [...seen.values()];
}

// List or open the editor's side panels. With no name, returns the sidebars
// registered on this site (name + label + active) so the model picks a real
// one. With a name, validates it against that list before opening — so we never
// "open" a phantom panel. No click, no content change.
function openSidebar(input = {}) {
  const available = listSidebars();
  const name = String(input.name || '').trim();
  if (!name) return {available};

  const match = available.find((s) => s.name === name);
  if (!match) {
    return {error: `No sidebar "${name}" is registered here.`, available};
  }
  const d =
    wpData().dispatch('core/edit-post') || wpData().dispatch('core/editor');
  const sel =
    wpData().select('core/edit-post') || wpData().select('core/editor');
  if (!d?.openGeneralSidebar) {
    return {error: 'Sidebar control is unavailable in this editor.'};
  }
  d.openGeneralSidebar(name);
  return {
    ok: true,
    opened: name,
    label: match.label,
    active: sel?.getActiveGeneralSidebarName?.() ?? null,
  };
}
