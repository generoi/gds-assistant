/**
 * Per-tool-call state and actions plumbed deep into the message tree to
 * {@link ./ToolCallFallback#ToolCallFallback}, which assistant-ui
 * instantiates as a render-prop component — so the modal can't pass props
 * to it directly.
 *
 * Lives in its own module so the components that consume it (the tool-call
 * fallback, future per-tool-action extractions) can read it without
 * re-importing the entire modal.
 *
 * Despite the name, this carries more than undo state now (retry, pending
 * approval). Keeping the file/symbol name to avoid a sprawling rename;
 * consider `ToolCallActionsContext` if more actions land.
 */

import { createContext } from "@wordpress/element";

/** State for a single undoable action, keyed by the assistant-ui tool-call id. */
export interface UndoableAction {
  /**
   * Audit log row id (`{$prefix}gds_assistant_audit_log.id`); passed back to
   * {@link UndoContextValue.onUndo} which POSTs it to `/undo`.
   */
  auditId: number;
  /** Human label shown on the Undo button (e.g. `"Restore post"`). */
  label: string;
  /** Set after the undo POST resolves; the button stops responding. */
  undone: boolean;
  /** While the undo POST is in-flight. */
  pending?: boolean;
  /** Error message from a failed undo attempt, if any. */
  error?: string | null;
  /** Caveats returned by the undo (e.g. "term recreated with new id"). */
  caveats?: string[];
}

export interface UndoContextValue {
  /** Keyed by tool-call id. Missing key = nothing to undo for that call. */
  undoableActions: Record<string, UndoableAction>;
  /** Called by the Undo button. Null when no provider is mounted (smoke tests). */
  onUndo: ((toolCallId: string, auditId: number) => void) | null;
  /** Called by the Retry button. Null when no provider is mounted. */
  onRetry: ((toolCallId: string) => void) | null;
  /** Ids currently mid-retry; drives the spinner. */
  retryingIds: Set<string>;
  /** Tool calls awaiting a destructive-action approval click. */
  pendingApprovalIds: Set<string>;
}

export const UndoContext = createContext<UndoContextValue>({
  undoableActions: {},
  onUndo: null,
  onRetry: null,
  retryingIds: new Set(),
  pendingApprovalIds: new Set(),
});
