/**
 * Per-tool undo + pending-approval state plumbed deep into the message tree
 * to {@link ./ToolCallFallback#ToolCallFallback}, which assistant-ui
 * instantiates as a render-prop component — so the modal can't pass props
 * to it directly.
 *
 * Lives in its own module so the components that consume it (the tool-call
 * fallback, future undo-button extractions) can read it without re-importing
 * the entire modal.
 *
 * Shape:
 *   undoableActions: Record<toolCallId, {auditId, label, undone, pending, error?, caveats?}>
 *   onUndo: (toolCallId: string, auditId: string) => void | null
 *   pendingApprovalIds: Set<toolCallId>
 */

import { createContext } from "@wordpress/element";

export const UndoContext = createContext({
  undoableActions: {},
  onUndo: null,
  pendingApprovalIds: new Set(),
});
