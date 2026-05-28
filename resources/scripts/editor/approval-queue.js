/**
 * Per-tool-call approval queue for inline edit confirmation.
 *
 * When the user has "Confirm edits before applying" turned on, the editor
 * write tools (replace/insert/update/recover) call `enqueueApproval` instead
 * of mutating right away. The Promise it returns stays pending until the
 * ToolCallFallback's diff card resolves it via `resolveApproval` (Apply or
 * Reject). That decision is also surfaced as the tool result so the model
 * understands what the user did.
 *
 * Module-level state — there's one chat instance per page, and tool calls
 * are scoped by their unique tool_use_id, so a singleton is enough. A small
 * subscribe pattern lets the React diff-card UI re-render when entries are
 * added or resolved.
 */

const ENABLED_KEY = 'gds-assistant-confirm-edits';
const PREF_EVENT = 'gds-assistant-confirm-edits-pref';
const queue = new Map(); // toolUseId → entry
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore subscriber errors so one bad listener doesn't break the rest
    }
  }
}

/** Default ON so dangerous edits don't go through silently. */
export function confirmEditsEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function setConfirmEdits(value) {
  try {
    localStorage.setItem(ENABLED_KEY, value ? '1' : '0');
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(PREF_EVENT));
}

export const CONFIRM_PREF_EVENT = PREF_EVENT;

/**
 * Stage a pending approval. Returns a Promise that resolves with either
 * `{approved: true}` or `{approved: false}` when the user clicks Apply
 * or Reject in the diff card.
 *
 * @param {string} toolUseId  Stable tool_use_id from the model.
 * @param {Object} payload    {toolName, input, before, summary}
 *                            `before` is whatever snapshot the diff card
 *                            should display as the "current" state.
 */
export function enqueueApproval(toolUseId, payload) {
  if (!toolUseId) {
    // No id → can't correlate with the diff card; auto-approve to avoid a
    // dangling Promise.
    return Promise.resolve({approved: true});
  }
  return new Promise((resolve) => {
    queue.set(toolUseId, {...payload, resolve});
    notify();
  });
}

export function getApproval(toolUseId) {
  return queue.get(toolUseId) || null;
}

export function resolveApproval(toolUseId, approved) {
  const entry = queue.get(toolUseId);
  if (!entry) return;
  queue.delete(toolUseId);
  notify();
  entry.resolve({approved: !!approved});
}

/**
 * If the chat panel closes mid-approval (component unmount), auto-reject so
 * the loop doesn't hang. Idempotent.
 */
export function clearAllApprovals() {
  for (const [, entry] of queue) {
    entry.resolve({approved: false, aborted: true});
  }
  queue.clear();
  notify();
}

export function subscribeApprovals(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hasPendingApproval(toolUseId) {
  return queue.has(toolUseId);
}
