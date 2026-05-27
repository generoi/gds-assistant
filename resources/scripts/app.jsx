import {AssistantRuntimeProvider} from '@assistant-ui/react';
import {useState, useCallback, useEffect} from '@wordpress/element';
import {AssistantModal} from './components/assistant-modal';
import {
  useAssistantRuntime,
  newChat,
  setSystemContext,
  getPersistedConversationId,
} from './hooks/use-runtime-adapter';

const OPEN_KEY = 'gds-assistant-open';

export function App() {
  const {
    runtime,
    loadConversation,
    approveToolCall,
    denyToolCall,
    pendingApprovals,
    undoableActions,
    undoAction,
  } = useAssistantRuntime();
  const [context, setContext] = useState('');

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
    const resumeUuid = localStorage.getItem('gds-assistant-resume');
    if (resumeUuid) {
      localStorage.removeItem('gds-assistant-resume');
      loadConversation(resumeUuid);
      // Open the modal after a short delay
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('gds-assistant-resume', {detail: {uuid: resumeUuid}}),
        );
      }, 200);
    } else if (localStorage.getItem(OPEN_KEY) === '1') {
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
    window.addEventListener('gds-assistant-resume', handler);
    return () => window.removeEventListener('gds-assistant-resume', handler);
  }, [loadConversation]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
      />
    </AssistantRuntimeProvider>
  );
}
