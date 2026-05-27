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
        return readSelection();
      case 'editor__replace_blocks':
        return replaceBlocks(input);
      case 'editor__insert_blocks':
        return insertBlocks(input);
      case 'editor__update_block_attributes':
        return updateBlockAttributes(input);
      case 'editor__update_post':
        return updatePost(input);
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

function readSelection() {
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
  // an edit changed ids — by matching on name + text rather than a cached id.
  const allIds = be.getClientIdsWithDescendants?.() || [];
  const outline = allIds
    .map((id) => {
      const block = be.getBlock?.(id);
      if (!block) return null;
      return {
        client_id: id,
        name: block.name,
        depth: (be.getBlockParents?.(id) || []).length,
        text: blockSnippet(block),
      };
    })
    .filter(Boolean);

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
