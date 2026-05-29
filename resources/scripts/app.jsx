import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
} from "@wordpress/element";

import {
  getPersistedConversationId,
  newChat,
  setSystemContext,
  useAssistantRuntime,
} from "./hooks/use-runtime-adapter";

// Lazy-load the modal subtree. It pulls in @assistant-ui/react-streamdown,
// @assistant-ui/react-markdown, and the carved component tree
// (Composer, Thread, Messages, SidePanels, ToolCallFallback, MicButton,
// ReadAloudController) — none of which is needed for the first paint of the
// pages that just mount the floating ✦ trigger. Saves ~half the initial
// bundle. Trade-off: the trigger button and Cmd+K shortcut take a tick to
// appear after page load while the chunk arrives.
const AssistantModal = lazy(() =>
  import("./components/assistant-modal").then((m) => ({
    default: m.AssistantModal,
  })),
);

const OPEN_KEY = "gds-assistant-open";

export function App() {
  const {
    runtime,
    loadConversation,
    approveToolCall,
    denyToolCall,
    pendingApprovals,
    undoableActions,
    undoAction,
    retryToolCall,
    retryingIds,
  } = useAssistantRuntime();
  const [context, setContext] = useState("");

  const handleNewChat = useCallback(() => {
    newChat();
    loadConversation(null);
  }, [loadConversation]);

  const handleContextChange = useCallback((val) => {
    setContext(val);
    setSystemContext(val);
  }, []);

  // Resume conversation from settings page or localStorage
  useEffect(() => {
    // Check localStorage for resume request (cross-page)
    const resumeUuid = localStorage.getItem("gds-assistant-resume");
    if (resumeUuid) {
      localStorage.removeItem("gds-assistant-resume");
      loadConversation(resumeUuid);
      // Open the modal after a short delay
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("gds-assistant-resume", {
            detail: { uuid: resumeUuid },
          }),
        );
      }, 200);
    } else if (localStorage.getItem(OPEN_KEY) === "1") {
      // The chat was left open on the previous wp-admin page — restore its
      // active thread so reopening lands on the same conversation. The modal
      // reopens itself via defaultOpen (see assistant-modal).
      const activeUuid = getPersistedConversationId();
      if (activeUuid) {
        loadConversation(activeUuid);
      }
    }

    // Listen for resume events from the conversations DataView
    const handler = (e) => {
      if (e.detail?.uuid) {
        loadConversation(e.detail.uuid);
      }
    };
    window.addEventListener("gds-assistant-resume", handler);
    return () => window.removeEventListener("gds-assistant-resume", handler);
  }, [loadConversation]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Suspense fallback={null}>
        <AssistantModal
          onNewChat={handleNewChat}
          onLoadConversation={loadConversation}
          systemContext={context}
          onSystemContextChange={handleContextChange}
          onApproveToolCall={approveToolCall}
          onDenyToolCall={denyToolCall}
          pendingApprovals={pendingApprovals}
          undoableActions={undoableActions}
          onUndo={undoAction}
          onRetry={retryToolCall}
          retryingIds={retryingIds}
        />
      </Suspense>
    </AssistantRuntimeProvider>
  );
}
