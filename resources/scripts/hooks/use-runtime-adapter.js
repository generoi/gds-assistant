import {useExternalStoreRuntime} from '@assistant-ui/react';
import {useState, useRef, useCallback, useMemo} from '@wordpress/element';

// Session state
let currentConversationId = null;
let currentModel = localStorage.getItem('gds-assistant-model') || '';
let currentMaxTokens =
  parseInt(localStorage.getItem('gds-assistant-max-tokens'), 10) || 0;
let currentSystemContext = '';

const sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  listeners: new Set(),
};

// ── Public API ──────────────────────────────────────────────

export function setModel(model) {
  currentModel = model;
  localStorage.setItem('gds-assistant-model', model);
}
export function getModel() {
  return currentModel;
}
export function setMaxTokens(tokens) {
  currentMaxTokens = tokens;
  localStorage.setItem('gds-assistant-max-tokens', String(tokens));
}
export function getMaxTokens() {
  return currentMaxTokens;
}

export function setSystemContext(ctx) {
  currentSystemContext = ctx;
}

export function onUsageUpdate(callback) {
  sessionUsage.listeners.add(callback);
  callback({...sessionUsage});
  return () => sessionUsage.listeners.delete(callback);
}

function emitUsage(input, output) {
  sessionUsage.inputTokens += input;
  sessionUsage.outputTokens += output;
  // Calculate cost delta based on current model's pricing
  const pricing = window.gdsAssistant?.modelPricing?.[currentModel] || [3, 15]; // fallback to Sonnet
  const costDelta =
    (input / 1_000_000) * pricing[0] + (output / 1_000_000) * pricing[1];
  sessionUsage.cost += costDelta;
  for (const fn of sessionUsage.listeners) {
    fn({
      inputTokens: sessionUsage.inputTokens,
      outputTokens: sessionUsage.outputTokens,
      cost: sessionUsage.cost,
    });
  }
}

export function newChat() {
  currentConversationId = null;
  sessionUsage.inputTokens = 0;
  sessionUsage.outputTokens = 0;
  sessionUsage.cost = 0;
  for (const fn of sessionUsage.listeners) {
    fn({inputTokens: 0, outputTokens: 0, cost: 0});
  }
}

/**
 * Fetch conversation list from the REST API.
 *
 * @return {Promise<Array>} Array of conversation objects.
 */
export async function fetchConversations() {
  const {restUrl, nonce} = window.gdsAssistant || {};
  const response = await fetch(`${restUrl}conversations`, {
    headers: {'X-WP-Nonce': nonce},
  });
  if (!response.ok) return [];
  return response.json();
}

/**
 * Fetch a single conversation's messages.
 *
 * @param {string} uuid Conversation UUID.
 * @return {Promise<Object|null>} Conversation object with messages.
 */
export async function fetchConversation(uuid) {
  const {restUrl, nonce} = window.gdsAssistant || {};
  const response = await fetch(`${restUrl}conversations/${uuid}`, {
    headers: {'X-WP-Nonce': nonce},
  });
  if (!response.ok) return null;
  return response.json();
}

// ── Runtime hook ────────────────────────────────────────────

/**
 * Creates an ExternalStoreRuntime that we fully control.
 * Supports loading old conversations and streaming new ones.
 *
 * @return {Object} assistant-ui runtime.
 */
export function useAssistantRuntime() {
  const [messages, setMessages] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef(null);
  const pendingApprovalRef = useRef(null);
  const onNewRef = useRef(null);

  const onNew = useCallback(async (message) => {
    // Extract user text from the append message
    const userText =
      typeof message.content === 'string' ?
        message.content
      : message.content
          ?.map((p) => (p.type === 'text' ? p.text : ''))
          .join('') || '';

    // Add user message to state
    const userMsg = {role: 'user', content: [{type: 'text', text: userText}]};
    setMessages((prev) => [...prev, userMsg]);

    // Start streaming
    setIsRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const {restUrl, nonce} = window.gdsAssistant || {};
      const response = await fetch(`${restUrl}chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WP-Nonce': nonce,
        },
        body: JSON.stringify({
          messages: [{role: 'user', content: userText}],
          conversation_id: currentConversationId || '',
          model: currentModel || '',
          max_tokens: currentMaxTokens || undefined,
          system_context: currentSystemContext || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Chat request failed: ${response.status} ${error}`);
      }

      let text = '';

      for await (const event of parseSSE(response.body)) {
        switch (event.type) {
          case 'text_delta':
            text += event.data.text;
            break;
          case 'tool_use_start': {
            const toolLabel = event.data.name?.replace('__', '/');
            text += `\n\n---\n**Tool:** \`${toolLabel}\` `;
            if (event.data.input && Object.keys(event.data.input).length > 0) {
              text += `\n\`\`\`json\n${JSON.stringify(event.data.input, null, 2)}\n\`\`\`\n`;
            }
            // Use a unique marker per tool call so we can match results reliably
            const marker = `<!--tool:${event.data.id || toolLabel}-->`;
            text += `${marker}_Running..._\n`;
            break;
          }
          case 'tool_result': {
            // Find the matching marker or fall back to last "Running..."
            const toolId = event.data.tool_use_id || '';
            const marker = `<!--tool:${toolId}-->`;
            const status =
              event.data.is_error ?
                `**Error:** ${JSON.stringify(event.data.result)}\n\n---\n\n`
              : `**Done** \u2713\n\n---\n\n`;

            const markerIdx = text.indexOf(marker);
            if (markerIdx !== -1) {
              const endIdx = text.indexOf('\n', markerIdx + marker.length + 1);
              text =
                text.slice(0, markerIdx) +
                status +
                (endIdx !== -1 ? text.slice(endIdx + 1) : '');
            } else {
              // Fallback: replace last Running...
              const lastRunning = text.lastIndexOf('_Running..._\n');
              if (lastRunning !== -1) {
                text =
                  text.slice(0, lastRunning) +
                  status +
                  text.slice(lastRunning + '_Running..._\n'.length);
              }
            }
            break;
          }
          case 'tool_approval_required': {
            const approvalTool =
              event.data.tool_name?.replace('gds/', '') || 'unknown';
            const approvalId = event.data.tool_use_id || '';
            text += `\n\n---\n**Approval required:** \`${event.data.tool_name}\`\n`;
            if (event.data.input && Object.keys(event.data.input).length > 0) {
              text += `\`\`\`json\n${JSON.stringify(event.data.input, null, 2)}\n\`\`\`\n`;
            }
            text += `<!--approval:${approvalId}:${approvalTool}-->\n`;
            text += `_Waiting for approval..._\n`;
            pendingApprovalRef.current = {
              toolUseId: approvalId,
              toolName: event.data.tool_name,
              input: event.data.input,
            };
            break;
          }
          case 'ask_user':
            // Server-side tool is asking user a question with options
            text += `\n\n> **${event.data.question || 'Confirm?'}**\n`;
            if (event.data.options?.length) {
              text += event.data.options.map((o) => `> - ${o}`).join('\n');
            }
            text += '\n\n_Reply below to continue._\n';
            break;
          case 'error':
            text += `\n\n**Error:** ${event.data.message}\n`;
            break;
          case 'conversation_start':
            if (event.data.conversation_id) {
              currentConversationId = event.data.conversation_id;
            }
            // Server confirms which model is actually being used — update for pricing
            if (event.data.model) {
              currentModel = event.data.model;
            }
            break;
          case 'usage':
            emitUsage(
              event.data.input_tokens || 0,
              event.data.output_tokens || 0,
            );
            break;
          case 'message_stop':
            break;
        }

        // Update the assistant message in-place
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
            updated[lastIdx] = {
              role: 'assistant',
              content: [{type: 'text', text}],
            };
          } else {
            updated.push({
              role: 'assistant',
              content: [{type: 'text', text}],
            });
          }
          return updated;
        });
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: [{type: 'text', text: `**Error:** ${err.message}`}],
          },
        ]);
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, []);

  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
  }, []);

  /**
   * Load an old conversation's messages into the UI.
   *
   * @param {string} uuid Conversation UUID.
   */
  const loadConversation = useCallback(async (uuid) => {
    currentConversationId = uuid;

    if (!uuid) {
      setMessages([]);
      return;
    }

    const conv = await fetchConversation(uuid);
    if (!conv?.messages?.length) {
      setMessages([]);
      return;
    }

    // Restore token usage from the stored conversation
    sessionUsage.inputTokens = Number(conv.total_input_tokens) || 0;
    sessionUsage.outputTokens = Number(conv.total_output_tokens) || 0;
    // Estimate cost from stored tokens using default pricing (model may have changed)
    const pricing = window.gdsAssistant?.modelPricing?.[currentModel] || [
      3, 15,
    ];
    sessionUsage.cost =
      (sessionUsage.inputTokens / 1_000_000) * pricing[0] +
      (sessionUsage.outputTokens / 1_000_000) * pricing[1];
    for (const fn of sessionUsage.listeners) {
      fn({
        inputTokens: sessionUsage.inputTokens,
        outputTokens: sessionUsage.outputTokens,
        cost: sessionUsage.cost,
      });
    }
    // Convert stored messages to UI format, skipping tool-only messages
    const uiMessages = conv.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .reduce((acc, m) => {
        if (m.role === 'user') {
          const text =
            typeof m.content === 'string' ?
              m.content
            : (m.content || [])
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('');
          // Skip tool_result-only user messages (no visible text)
          if (!text) return acc;
          acc.push({role: 'user', content: [{type: 'text', text}]});
          return acc;
        }
        // Assistant: extract text blocks (content can be string or array)
        const text =
          typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ?
            m.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('')
          : '';
        // Skip assistant messages with no text (tool-use-only turns)
        if (!text) return acc;

        // Merge consecutive assistant messages (agentic loop produces multiple)
        const last = acc[acc.length - 1];
        if (last?.role === 'assistant') {
          last.content[0].text += '\n\n' + text;
          return acc;
        }

        acc.push({
          role: 'assistant',
          content: [{type: 'text', text}],
        });
        return acc;
      }, []);
    setMessages(uiMessages);
  }, []);

  const convertMessage = useCallback((msg) => {
    return {
      role: msg.role,
      content: msg.content,
    };
  }, []);

  const adapter = useMemo(
    () => ({
      messages,
      isRunning,
      onNew,
      onCancel,
      convertMessage,
    }),
    [messages, isRunning, onNew, onCancel, convertMessage],
  );

  // Keep ref to onNew for approval callbacks
  onNewRef.current = onNew;

  const approveToolCall = useCallback(() => {
    const pending = pendingApprovalRef.current;
    if (!pending) return;
    pendingApprovalRef.current = null;
    onNewRef.current?.({
      content: `__tool_approved__:${pending.toolUseId}`,
    });
  }, []);

  const denyToolCall = useCallback(() => {
    const pending = pendingApprovalRef.current;
    if (!pending) return;
    pendingApprovalRef.current = null;
    onNewRef.current?.({
      content: `__tool_denied__:${pending.toolUseId}`,
    });
  }, []);

  const runtime = useExternalStoreRuntime(adapter);

  return {
    runtime,
    loadConversation,
    approveToolCall,
    denyToolCall,
    pendingApprovalRef,
  };
}

// ── SSE parser ──────────────────────────────────────────────

/**
 * Parse SSE events from a ReadableStream.
 *
 * @param {ReadableStream} body Response body stream.
 */
async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (eventType && data) {
            try {
              yield {
                type: eventType,
                data: JSON.parse(data),
              };
            } catch {
              // Skip malformed JSON
            }
          }
          eventType = null;
        } else if (line.trim() === '') {
          eventType = null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
