/**
 * Cmd/Ctrl + J anywhere in the editor canvas is a fast jump into the chat:
 * we just open the chat panel and focus the composer. The composer already
 * shows the selection chip when a block / text-range is selected, so the
 * model has the context it needs — we don't preempt the user's intent
 * (write / edit / generate an image / whatever) with a templated prompt.
 *
 * Important: we ONLY fire when focus is in an editor surface. Sidebars,
 * modals, our own chat panel, and the WP admin chrome keep Cmd+J unbound so
 * we don't shadow native Gutenberg behaviour (Cmd+J is currently unused by
 * Gutenberg).
 */

const SHORTCUT_KEY = "j";

function isInsideEditorCanvas(target: EventTarget | null): boolean {
  if (!target) {
    return false;
  }
  const el = target as Element & {
    closest?: (selector: string) => Element | null;
  };
  // Don't intercept inside our own chat — we have our own shortcuts there.
  if (el.closest && el.closest(".gds-assistant")) {
    return false;
  }
  if (
    el.closest &&
    el.closest(
      "[data-block], .block-editor-rich-text__editable, .editor-styles-wrapper, .interface-interface-skeleton__content",
    )
  ) {
    return true;
  }
  return false;
}

function focusComposer(): void {
  // Tiny delay so the panel transition can mount the composer first.
  setTimeout(() => {
    const input = document.querySelector<
      HTMLTextAreaElement | HTMLInputElement
    >(".gds-assistant__input");
    if (input) {
      input.focus();
      const len = (input.value || "").length;
      try {
        input.setSelectionRange(len, len);
      } catch {
        // Not all inputs support selection ranges (e.g. some textareas).
      }
    }
  }, 120);
}

function handleKeydown(e: KeyboardEvent): void {
  const isMeta = e.metaKey || e.ctrlKey;
  if (!isMeta || e.shiftKey || e.altKey) {
    return;
  }
  if ((e.key || "").toLowerCase() !== SHORTCUT_KEY) {
    return;
  }
  if (!isInsideEditorCanvas(e.target)) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  window.gdsAssistant?.openChat?.();
  focusComposer();
}

window.addEventListener("keydown", handleKeydown, { capture: false });

// Editor canvas iframe (WP 6.3+ mounts the canvas there on most editor
// surfaces; absent on legacy non-iframed editors) — keydowns inside don't
// always bubble out, so wire a listener inside it too when it's present.
function attachIframeListener(): void {
  const iframe = document.querySelector<
    HTMLIFrameElement & { _gdsWriteCursorAttached?: boolean }
  >('iframe[name="editor-canvas"]');
  if (!iframe || iframe._gdsWriteCursorAttached) {
    return;
  }
  iframe._gdsWriteCursorAttached = true;
  const wire = (): void => {
    try {
      iframe.contentDocument?.addEventListener("keydown", handleKeydown, {
        capture: false,
      });
    } catch {
      // Cross-origin iframes can't be reached; safe to ignore.
    }
  };
  if (iframe.contentDocument?.readyState === "complete") {
    wire();
  } else {
    iframe.addEventListener("load", wire);
  }
}
const pollAttach = setInterval(() => {
  if (document.querySelector('iframe[name="editor-canvas"]')) {
    attachIframeListener();
    clearInterval(pollAttach);
  }
}, 500);
setTimeout(() => clearInterval(pollAttach), 30000);
