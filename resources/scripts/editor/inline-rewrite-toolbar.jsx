/**
 * Floating toolbar that appears when the user selects text inside a block in
 * the editor. Buttons send the selected text to the chat endpoint with an
 * instruction (rewrite / shorten / translate-to-LANG) and apply the model's
 * reply back to the same selection via applyInlineRewrite.
 *
 * Implementation notes:
 * - Detects the editor's selection through wp.data so it handles assistant-ui's
 *   rich-text state correctly. Uses the DOM Range only to position the toolbar.
 * - Uses onMouseDown + preventDefault on the buttons so clicking doesn't blur
 *   the selection (otherwise the rich-text selection collapses before onClick).
 * - Polylang languages come from the same `voiceLanguages` we expose for the
 *   dictation picker; we offer translation targets other than the page lang.
 */

import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from '@wordpress/element';
import {createPortal} from 'react-dom';
import {hasEditor, applyInlineRewrite} from './editor-bridge';

const SYSTEM_INSTRUCTION =
  'You are an inline text editor. Reply with ONLY the rewritten text — no preamble, no quotes, no commentary, no markdown.';

const ACTIONS = {
  rewrite: {
    label: 'Rewrite',
    prompt: (text) =>
      `Rewrite the following text in clearer, more engaging prose, keeping the same meaning and roughly the same length.\n\nText to rewrite:\n${text}`,
  },
  shorten: {
    label: 'Shorten',
    prompt: (text) =>
      `Shorten the following text to about half its length while preserving its meaning.\n\nText to shorten:\n${text}`,
  },
};

// Stream the chat endpoint and accumulate just the text deltas (we don't run
// tools or persist UX state here — it's a one-shot text request).
async function fetchInlineText(prompt) {
  const cfg = window.gdsAssistant || {};
  if (!cfg.restUrl || !cfg.nonce) throw new Error('assistant config missing');
  const response = await fetch(`${cfg.restUrl}chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WP-Nonce': cfg.nonce,
    },
    body: JSON.stringify({
      messages: [{role: 'user', content: prompt}],
      system_context: SYSTEM_INSTRUCTION,
    }),
  });
  if (!response.ok) {
    throw new Error(`chat ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = null;
  let out = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        if (eventType === 'text_delta') {
          try {
            const data = JSON.parse(line.slice(6));
            if (typeof data.text === 'string') out += data.text;
          } catch {
            // skip malformed
          }
        }
        eventType = null;
      } else if (line.trim() === '') {
        eventType = null;
      }
    }
  }
  // Strip stray surrounding quotes the model sometimes adds despite the
  // instruction.
  return out.trim().replace(/^['"“”«»]+|['"“”«»]+$/g, '').trim();
}

/** Read the current text selection inside one block. */
function readSelectionInfo() {
  const data = window.wp?.data;
  const be = data?.select?.('core/block-editor');
  if (!be?.getSelectionStart) return null;
  const start = be.getSelectionStart();
  const end = be.getSelectionEnd();
  if (
    !start?.clientId ||
    start.clientId !== end?.clientId ||
    start.offset === end?.offset
  ) {
    return null;
  }
  const dom = window.getSelection?.();
  if (!dom || dom.rangeCount === 0) return null;
  const text = dom.toString();
  if (!text.trim()) return null;
  return {
    clientId: start.clientId,
    attributeKey: start.attributeKey,
    text,
    rect: dom.getRangeAt(0).getBoundingClientRect(),
  };
}

export function InlineRewriteToolbar() {
  const [selection, setSelection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const editorRef = useRef(false);

  // Wait for the editor stores to be ready, then subscribe to selection.
  useEffect(() => {
    let unsub = null;
    let onSelChange = null;
    const trySubscribe = () => {
      if (!hasEditor() || !window.wp?.data?.subscribe) {
        editorRef.current = false;
        return false;
      }
      editorRef.current = true;
      const update = () => {
        // Avoid hiding the toolbar while a request is in flight (the model's
        // reply arrives after the selection is gone).
        if (busy) return;
        setSelection(readSelectionInfo());
      };
      unsub = window.wp.data.subscribe(update);
      onSelChange = update;
      document.addEventListener('selectionchange', onSelChange);
      update();
      return true;
    };
    if (!trySubscribe()) {
      const iv = setInterval(() => {
        if (trySubscribe()) clearInterval(iv);
      }, 500);
      return () => clearInterval(iv);
    }
    return () => {
      unsub?.();
      if (onSelChange) {
        document.removeEventListener('selectionchange', onSelChange);
      }
    };
  }, [busy]);

  const run = useCallback(
    async (prompt) => {
      if (!selection || busy) return;
      const captured = selection;
      setBusy(true);
      setError(null);
      try {
        const newText = await fetchInlineText(prompt);
        if (!newText) {
          setError('No reply');
          return;
        }
        const result = applyInlineRewrite(captured, newText);
        if (!result.ok) setError(result.error || 'Could not apply');
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setBusy(false);
        // Clear the selection state so the toolbar hides after a successful
        // edit; on error we keep showing it so the user can retry.
      }
    },
    [selection, busy],
  );

  if (!editorRef.current || !selection) return null;

  const langs = window.gdsAssistant?.voiceLanguages || [];
  const pagePrimary = (
    document.documentElement.lang || ''
  )
    .toLowerCase()
    .split('-')[0];
  const translateTargets = langs.filter(
    (l) => l.code.toLowerCase().split('-')[0] !== pagePrimary,
  );

  // Position the toolbar just above the selection rectangle (viewport coords;
  // we use position: fixed so we don't have to track scroll).
  const r = selection.rect;
  const TOOLBAR_GAP = 8;
  const top = Math.max(r.top - 40 - TOOLBAR_GAP, 8);
  const left = Math.max(r.left, 8);

  const stopBlur = (e) => e.preventDefault();

  return createPortal(
    <div
      className="gds-assistant__inline-toolbar"
      style={{top, left}}
      onMouseDown={stopBlur}
    >
      <button
        type="button"
        className="gds-assistant__inline-action"
        disabled={busy}
        onClick={() => run(ACTIONS.rewrite.prompt(selection.text))}
      >
        {ACTIONS.rewrite.label}
      </button>
      <button
        type="button"
        className="gds-assistant__inline-action"
        disabled={busy}
        onClick={() => run(ACTIONS.shorten.prompt(selection.text))}
      >
        {ACTIONS.shorten.label}
      </button>
      {translateTargets.map((l) => (
        <button
          key={l.code}
          type="button"
          className="gds-assistant__inline-action gds-assistant__inline-action--translate"
          disabled={busy}
          title={`Translate to ${l.name}`}
          onClick={() =>
            run(
              `Translate the following text to ${l.name}. Preserve tone and meaning.\n\nText to translate:\n${selection.text}`,
            )
          }
        >
          → {l.slug.toUpperCase()}
        </button>
      ))}
      {busy && (
        <span className="gds-assistant__inline-spinner" aria-hidden="true">
          …
        </span>
      )}
      {error && !busy && (
        <span className="gds-assistant__inline-error" title={error}>
          ⚠
        </span>
      )}
    </div>,
    document.body,
  );
}
