/**
 * React hook returning the current single-block text-range selection in the
 * live Gutenberg editor (or `null` when nothing relevant is selected). Drives
 * the composer chip + the inline context attached to outgoing messages.
 *
 * `wp.data.subscribe` fires on every store mutation, which is very frequent
 * during typing. We dedupe by shallow-comparing the relevant fields so the
 * composer doesn't re-render on each keystroke when the selection hasn't
 * meaningfully changed.
 */

import { useEffect, useState } from "@wordpress/element";
import { getCurrentSelectionContext } from "../editor/selection";

function sameSelection(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.mode !== b.mode) {
    return false;
  }
  if (a.mode === "text-range") {
    return (
      a.clientId === b.clientId &&
      a.selectedText === b.selectedText &&
      a.blockText === b.blockText
    );
  }
  if (a.mode === "whole-block") {
    return (
      a.clientId === b.clientId &&
      a.blockName === b.blockName &&
      a.blockText === b.blockText
    );
  }
  if (a.mode === "multi-block") {
    return (
      a.count === b.count &&
      (a.clientIds || []).join("|") === (b.clientIds || []).join("|")
    );
  }
  return false;
}

export function useEditorSelection() {
  const [selection, setSelection] = useState(() =>
    getCurrentSelectionContext(),
  );

  useEffect(() => {
    const data = window.wp?.data;
    if (!data?.subscribe) {
      return undefined;
    }

    let prev = getCurrentSelectionContext();
    setSelection(prev);

    const unsub = data.subscribe(() => {
      const next = getCurrentSelectionContext();
      if (!sameSelection(prev, next)) {
        prev = next;
        setSelection(next);
      }
    });
    return unsub;
  }, []);

  return selection;
}
