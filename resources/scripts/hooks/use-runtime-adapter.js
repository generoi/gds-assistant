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
  const pricing = window.gdsAssistant?.modelPricing?.[currentModel] || [3, 15];
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
 * Messages use structured content parts (text, tool-call, image)
 * so assistant-ui can render them with native components.
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
    // Build content blocks from text + attachments
    const contentBlocks = [];

    const userText =
      typeof message.content === 'string' ?
        message.content
      : message.content
          ?.map((p) => (p.type === 'text' ? p.text : ''))
          .join('') || '';

    if (userText) {
      contentBlocks.push({type: 'text', text: userText});
    }

    // Process image attachments — prefer URL (uploaded to media library) over base64
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        const contentType = attachment.contentType || '';
        if (!contentType.startsWith('image/')) continue;

        const imageContent = attachment.content?.[0];
        if (!imageContent?.image) continue;

        const imageUrl = imageContent.image;
        const mediaId = imageContent.mediaId;

        if (mediaId || !imageUrl.startsWith('data:')) {
          // Uploaded to media library — use URL (saves context tokens)
          contentBlocks.push({
            type: 'image',
            source: {type: 'url', url: imageUrl},
          });
        } else {
          // Fallback: data URL → extract base64
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            contentBlocks.push({
              type: 'image',
              source: {type: 'base64', media_type: match[1], data: match[2]},
            });
          }
        }
      }
    }

    const userMsg = {role: 'user', content: contentBlocks};
    setMessages((prev) => [...prev, userMsg]);

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
          messages: [{role: 'user', content: contentBlocks}],
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

      // Build structured content parts from SSE events
      const parts = [];
      let currentTextIdx = -1;

      /**
       * Ensure a text part exists at the end of `parts` to append to.
       *
       * @return {number} Index of the current text part.
       */
      const ensureTextPart = () => {
        if (currentTextIdx < 0 || parts[currentTextIdx]?.type !== 'text') {
          currentTextIdx = parts.length;
          parts.push({type: 'text', text: ''});
        }
        return currentTextIdx;
      };

      for await (const event of parseSSE(response.body)) {
        switch (event.type) {
          case 'text_delta': {
            const idx = ensureTextPart();
            parts[idx].text += event.data.text;
            break;
          }

          case 'tool_use_start': {
            // End any current text part — tool call is a separate part
            currentTextIdx = -1;
            parts.push({
              type: 'tool-call',
              toolCallId: event.data.id || `tool_${parts.length}`,
              toolName: event.data.name?.replace('__', '/') || 'unknown',
              args: event.data.input || {},
              argsText: JSON.stringify(event.data.input || {}, null, 2),
              // result will be set when tool_result arrives
            });
            break;
          }

          case 'tool_result': {
            const toolId = event.data.tool_use_id || '';
            const toolPart = parts.find(
              (p) => p.type === 'tool-call' && p.toolCallId === toolId,
            );
            if (toolPart) {
              toolPart.result = event.data.result;
              toolPart.isError = !!event.data.is_error;
            }
            // Next text goes into a new text part
            currentTextIdx = -1;
            break;
          }

          case 'tool_approval_required': {
            currentTextIdx = -1;
            const approvalId = event.data.tool_use_id || '';
            parts.push({
              type: 'tool-call',
              toolCallId: approvalId,
              toolName: event.data.tool_name || 'unknown',
              args: event.data.input || {},
              argsText: JSON.stringify(event.data.input || {}, null, 2),
              status: {type: 'requires-action', reason: 'tool-calls'},
            });
            pendingApprovalRef.current = {
              toolUseId: approvalId,
              toolName: event.data.tool_name,
              input: event.data.input,
            };
            break;
          }

          case 'ask_user': {
            const idx = ensureTextPart();
            parts[idx].text +=
              `\n\n> **${event.data.question || 'Confirm?'}**\n`;
            if (event.data.options?.length) {
              parts[idx].text += event.data.options
                .map((o) => `> - ${o}`)
                .join('\n');
            }
            parts[idx].text += '\n\n_Reply below to continue._\n';
            break;
          }

          case 'error': {
            const idx = ensureTextPart();
            parts[idx].text += `\n\n**Error:** ${event.data.message}\n`;
            break;
          }

          case 'conversation_start':
            if (event.data.conversation_id) {
              currentConversationId = event.data.conversation_id;
            }
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

        // Update the assistant message with structured parts
        const contentParts = parts.map((p) => ({...p}));
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
            updated[lastIdx] = {role: 'assistant', content: contentParts};
          } else {
            updated.push({role: 'assistant', content: contentParts});
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

    // Restore token usage
    sessionUsage.inputTokens = Number(conv.total_input_tokens) || 0;
    sessionUsage.outputTokens = Number(conv.total_output_tokens) || 0;
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

    // Convert stored messages to structured UI format
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
          if (!text) return acc;
          acc.push({role: 'user', content: [{type: 'text', text}]});
          return acc;
        }

        // Assistant: build structured parts from stored content
        const parts = [];
        const blocks =
          typeof m.content === 'string' ? [{type: 'text', text: m.content}]
          : Array.isArray(m.content) ? m.content
          : [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            parts.push({type: 'text', text: block.text});
          } else if (block.type === 'tool_use') {
            // Append message index to ensure uniqueness across turns
            const uniqueId = `${block.id || 'tool'}_msg${acc.length}`;
            parts.push({
              type: 'tool-call',
              toolCallId: uniqueId,
              toolName: (block.name || '').replace('__', '/'),
              args: block.input || {},
              argsText: JSON.stringify(block.input || {}, null, 2),
            });
          }
        }

        if (!parts.length) return acc;

        acc.push({role: 'assistant', content: parts});
        return acc;
      }, []);

    setMessages(uiMessages);
  }, []);

  const convertMessage = useCallback((msg) => {
    // Convert our server format to assistant-ui's expected format
    const content = (msg.content || []).map((part) => {
      if (part.type === 'image' && part.source) {
        // Our format: {type:'image', source:{type:'url',url}} or {type:'base64',data}
        const url =
          part.source.type === 'url' ?
            part.source.url
          : `data:${part.source.media_type};base64,${part.source.data}`;
        return {type: 'image', image: url};
      }
      return part;
    });
    return {role: msg.role, content};
  }, []);

  // Edit: truncate conversation to the edited message and re-send
  const onEdit = useCallback(
    (message) => {
      const parentId = message.parentId;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === parentId);
        return idx >= 0 ? prev.slice(0, idx) : prev;
      });
      onNew(message);
    },
    [onNew],
  );

  // Reload: re-send from a parent message (retry)
  const onReload = useCallback(
    (parentId) => {
      setMessages((prev) => {
        if (!parentId) return [];
        const idx = prev.findIndex((m) => m.id === parentId);
        const truncated = idx >= 0 ? prev.slice(0, idx + 1) : prev;
        const lastUser = [...truncated]
          .reverse()
          .find((m) => m.role === 'user');
        if (lastUser) {
          const text =
            lastUser.content
              ?.map((p) => (p.type === 'text' ? p.text : ''))
              .join('') || '';
          if (text) {
            setTimeout(() => onNew({content: text}), 0);
          }
        }
        return truncated;
      });
    },
    [onNew],
  );

  // Background upload promises keyed by attachment ID
  const uploadPromises = useRef({});

  const attachmentAdapter = useMemo(
    () => ({
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      async add({file}) {
        const id = Math.random().toString(36).slice(2);
        const previewUrl = URL.createObjectURL(file);

        // Start upload in background — don't await
        const {nonce, restBase} = window.gdsAssistant || {};
        const formData = new FormData();
        formData.append('file', file);
        uploadPromises.current[id] = fetch(`${restBase}media?gds_assistant=1`, {
          method: 'POST',
          headers: {'X-WP-Nonce': nonce},
          body: formData,
        }).then((r) => r.json());

        // Return immediately with local preview
        return {
          id,
          type: 'image',
          name: file.name,
          contentType: file.type,
          file,
          status: {type: 'requires-action', reason: 'composer-send'},
          content: [{type: 'image', image: previewUrl}],
        };
      },
      async send(attachment) {
        // Wait for background upload to finish
        const uploadResult = uploadPromises.current[attachment.id];
        delete uploadPromises.current[attachment.id];

        if (uploadResult) {
          try {
            const media = await uploadResult;
            return {
              ...attachment,
              status: {type: 'complete'},
              content: [
                {type: 'image', image: media.source_url, mediaId: media.id},
              ],
            };
          } catch {
            // Fall through to base64
          }
        }

        // Fallback to base64
        const base64 = await fileToBase64(attachment.file);
        return {
          ...attachment,
          status: {type: 'complete'},
          content: [
            {
              type: 'image',
              image: `data:${attachment.contentType};base64,${base64}`,
            },
          ],
        };
      },
      async remove(attachment) {
        delete uploadPromises.current[attachment.id];
      },
    }),
    [],
  );

  const adapter = useMemo(
    () => ({
      messages,
      isRunning,
      onNew,
      onEdit,
      onReload,
      onCancel,
      convertMessage,
      adapters: {
        attachments: attachmentAdapter,
      },
    }),
    [
      messages,
      isRunning,
      onNew,
      onEdit,
      onReload,
      onCancel,
      convertMessage,
      attachmentAdapter,
    ],
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

// ── Helpers ─────────────────────────────────────────────────

/**
 * Read a File object as base64 string (without the data: prefix).
 *
 * @param {File} file File to read.
 * @return {Promise<string|null>} Base64 string or null on error.
 */
function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl?.split(',')[1] || null;
      resolve(base64);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
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
