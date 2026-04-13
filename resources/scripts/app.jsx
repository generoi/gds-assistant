import {AssistantRuntimeProvider} from '@assistant-ui/react';
import {useState, useCallback} from '@wordpress/element';
import {AssistantModal} from './components/assistant-modal';
import {
  useAssistantRuntime,
  newChat,
  setSystemContext,
} from './hooks/use-runtime-adapter';

export function App() {
  const {runtime, loadConversation} = useAssistantRuntime();
  const [context, setContext] = useState('');

  const handleNewChat = useCallback(() => {
    newChat();
    loadConversation(null);
  }, [loadConversation]);

  const handleContextChange = useCallback((val) => {
    setContext(val);
    setSystemContext(val);
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssistantModal
        onNewChat={handleNewChat}
        onLoadConversation={loadConversation}
        systemContext={context}
        onSystemContextChange={handleContextChange}
      />
    </AssistantRuntimeProvider>
  );
}
