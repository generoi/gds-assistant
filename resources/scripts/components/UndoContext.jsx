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
 *
 * Shape:
 *   undoableActions: Record<toolCallId, {auditId, label, undone, pending, error?, caveats?}>
 *   onUndo: (toolCallId: string, auditId: string) => void | null
 *   onRetry: (toolCallId: string) => void | null
 *   retryingIds: Set<toolCallId>  // ids currently mid-retry; drives the spinner
 *   pendingApprovalIds: Set<toolCallId>
 */

import { createContext } from "@wordpress/element";

export const UndoContext = createContext({
  undoableActions: {},
  onUndo: null,
  onRetry: null,
  retryingIds: new Set(),
  pendingApprovalIds: new Set(),
});
