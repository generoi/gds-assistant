/**
 * Inline write-at-cursor: Cmd+J anywhere in the editor canvas opens a tiny
 * floating prompt pinned to the active block. Enter sends a message into the
 * chat asking the model to insert new content after the current block — flows
 * through the existing `editor__insert_blocks` tool so the diff card,
 * change-highlight, and undo all fire as normal. We do NOT register `/` slash
 * commands or anything else that would shadow Gutenberg's own behaviour.
 */

import {createRoot, useEffect, useRef, useState} from '@wordpress/element';

import {getBlockText, blockLabel} from './selection';

const SHORTCUT_KEY = 'j';
const ROOT_ID = 'gds-assistant-write-cursor-root';

/**
 * Find the DOM element for a block by clientId — looks in the top doc AND
 * inside the editor canvas iframe (WP 7.0 sometimes mounts the editor there).
 * Returns the element along with the iframe rect so we can translate
 * iframe-relative coordinates to viewport space.
 */
function findBlockAnchor(clientId) {
  if (!clientId) return null;
  const sel = `[data-block="${clientId}"]`;
  const inMain = document.querySelector(sel);
  if (inMain) return {el: inMain, iframeRect: null};
  const iframe = document.querySelector('iframe[name="editor-canvas"]');
  if (iframe && iframe.contentDocument) {
    const el = iframe.contentDocument.querySelector(sel);
    if (el) return {el, iframeRect: iframe.getBoundingClientRect()};
  }
  return null;
}

/** Top-left viewport coords + size for an anchor block. */
function anchorViewportRect(anchor) {
  if (!anchor || !anchor.el) return null;
  const r = anchor.el.getBoundingClientRect();
  if (anchor.iframeRect) {
    return {
      top: r.top + anchor.iframeRect.top,
      left: r.left + anchor.iframeRect.left,
      width: r.width,
      height: r.height,
    };
  }
  return r;
}

function WriteAtCursorOverlay({clientId, anchor, onClose}) {
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const [prompt, setPrompt] = useState('');

  // Recompute position on scroll/resize so the bubble follows the block.
  const [coords, setCoords] = useState(() => anchorViewportRect(anchor));
  useEffect(() => {
    const reposition = () => setCoords(anchorViewportRect(anchor));
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on outside click — but ignore the click that opened us (it could
  // arrive after mount in microtask order).
  useEffect(() => {
    const opened = Date.now();
    const handler = (e) => {
      if (Date.now() - opened < 50) return;
      if (!wrapRef.current?.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const submit = () => {
    const text = prompt.trim();
    if (!text) {
      onClose();
      return;
    }
    const block = window.wp?.data?.select?.('core/block-editor')?.getBlock?.(clientId);
    const label = block?.name ? blockLabel(block.name) : 'block';
    const blockText = clientId ? getBlockText(clientId) : '';
    const contextLine = blockText
      ? `Current ${label} (${clientId}) reads: "${blockText.slice(0, 200)}${blockText.length > 200 ? '…' : ''}"`
      : clientId
        ? `Active block: ${clientId} (${label})`
        : 'No block selected — append at the end of the document.';

    const message =
      `Insert a new block right after the active one using editor__insert_blocks.\n\n` +
      `${contextLine}\n\n` +
      `What to write: ${text}`;

    window.gdsAssistant?.openChat?.();
    window.gdsAssistant?.sendChatMessage?.(message);
    onClose();
  };

  if (!coords) return null;
  // Position above the block; if there's no room, drop below it.
  const above = coords.top > 80;
  const top = above ? Math.max(8, coords.top - 52) : coords.top + coords.height + 8;
  const left = Math.max(8, Math.min(window.innerWidth - 360, coords.left));

  return (
    <div
      ref={wrapRef}
      className="gds-assistant__write-overlay"
      style={{
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
      }}
      role="dialog"
      aria-label="AI write at cursor"
    >
      <span className="gds-assistant__write-overlay-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.5l2.2 5.8 5.8 2.2-5.8 2.2L12 18.5l-2.2-5.8L4 10.5l5.8-2.2L12 2.5z" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        className="gds-assistant__write-overlay-input"
        placeholder="Ask AI to write the next block…"
        aria-label="Prompt for AI to write the next block"
      />
      <button
        type="button"
        onClick={submit}
        className="gds-assistant__write-overlay-submit"
        title="Send (Enter)"
      >
        Write
      </button>
      <span className="gds-assistant__write-overlay-hint">
        Enter · Esc to cancel
      </span>
    </div>
  );
}

/** Singleton mount-and-render so a second Cmd+J replaces the prior overlay. */
function showOverlay(clientId, anchor) {
  let host = document.getElementById(ROOT_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ROOT_ID;
    document.body.appendChild(host);
  }
  let root = host._gdsRoot;
  if (!root) {
    root = createRoot(host);
    host._gdsRoot = root;
  }
  const close = () => root.render(null);
  root.render(
    <WriteAtCursorOverlay clientId={clientId} anchor={anchor} onClose={close} />,
  );
}

function isInsideEditorCanvas(target) {
  if (!target) return false;
  // Reject if the keydown happened inside our chat — we own that input there.
  if (target.closest && target.closest('.gds-assistant')) return false;
  // Accept block-editor surfaces in the main doc and the canvas iframe.
  if (
    target.closest &&
    target.closest(
      '[data-block], .block-editor-rich-text__editable, .editor-styles-wrapper, .interface-interface-skeleton__content',
    )
  )
    return true;
  // Inside an iframe? closest() above already crawls within that doc.
  return false;
}

function handleKeydown(e) {
  const isMeta = e.metaKey || e.ctrlKey;
  if (!isMeta || e.shiftKey || e.altKey) return;
  if ((e.key || '').toLowerCase() !== SHORTCUT_KEY) return;
  if (!isInsideEditorCanvas(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  const blockEditor = window.wp?.data?.select?.('core/block-editor');
  const clientId = blockEditor?.getSelectedBlockClientIds?.()?.[0] || null;
  const anchor = clientId
    ? findBlockAnchor(clientId)
    : {el: e.target.closest('[data-block], .interface-interface-skeleton__content') || document.body, iframeRect: null};

  showOverlay(clientId, anchor);
}

// Register on the top window only; the editor iframe inherits the same
// keydown via bubbling for shortcuts that escape, and our own listener
// inside the iframe handles the inverse case.
window.addEventListener('keydown', handleKeydown, {capture: false});

// Also listen inside the canvas iframe once it mounts — keys typed inside
// a contenteditable in the iframe don't always bubble out to the host.
function attachIframeListener() {
  const iframe = document.querySelector('iframe[name="editor-canvas"]');
  if (!iframe || iframe._gdsWriteCursorAttached) return;
  iframe._gdsWriteCursorAttached = true;
  const wire = () => {
    try {
      iframe.contentDocument?.addEventListener('keydown', handleKeydown, {capture: false});
    } catch {
      // Cross-origin guard — safe to ignore; iframe is same-origin in practice.
    }
  };
  if (iframe.contentDocument?.readyState === 'complete') {
    wire();
  } else {
    iframe.addEventListener('load', wire);
  }
}
// Editor canvas mounts later than this module loads — poll briefly.
const pollAttach = setInterval(() => {
  if (document.querySelector('iframe[name="editor-canvas"]')) {
    attachIframeListener();
    clearInterval(pollAttach);
  }
}, 500);
// Stop polling after 30s — non-iframed editors never satisfy the predicate.
setTimeout(() => clearInterval(pollAttach), 30000);
