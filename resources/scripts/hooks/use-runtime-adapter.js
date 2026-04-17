import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useState, useRef, useCallback, useMemo } from "@wordpress/element";

// Session state
let currentConversationId = null;
let currentModel = localStorage.getItem("gds-assistant-model") || "";
let currentMaxTokens =
  parseInt(localStorage.getItem("gds-assistant-max-tokens"), 10) || 0;
let currentSystemContext = "";

const sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  listeners: new Set(),
};

// ── Public API ──────────────────────────────────────────────

export function setModel(model) {
  currentModel = model;
  localStorage.setItem("gds-assistant-model", model);
}
export function getModel() {
  return currentModel;
}
export function setMaxTokens(tokens) {
  currentMaxTokens = tokens;
  localStorage.setItem("gds-assistant-max-tokens", String(tokens));
}
export function getMaxTokens() {
  return currentMaxTokens;
}

export function setSystemContext(ctx) {
  currentSystemContext = ctx;
}

export function onUsageUpdate(callback) {
  sessionUsage.listeners.add(callback);
  callback({ ...sessionUsage });
  return () => sessionUsage.listeners.delete(callback);
}

/**
 * Emit usage update with cache-aware cost calculation.
 *
 * pricing array: [input, output, cache_read, cache_write] — all $/M tokens.
 * All providers now emit unified fields: input_tokens (total),
 * cache_read_tokens (subset), cache_write_tokens (subset).
 *
 * @param {number} input   Total input tokens (includes cached)
 * @param {number} output  Output tokens
 * @param {number} cacheRead  Tokens served from cache (subset of input)
 * @param {number} cacheWrite Tokens written to cache (subset of input, Anthropic only)
 */
function emitUsage(input, output, cacheRead = 0, cacheWrite = 0) {
  sessionUsage.inputTokens += input;
  sessionUsage.outputTokens += output;

  // pricing: [input, output, cache_read, cache_write]
  // cache_read/cache_write default to input price when not specified.
  const pricing = window.gdsAssistant?.modelPricing?.[currentModel] || [3, 15];
  const inputPrice = pricing[0];
  const outputPrice = pricing[1];
  const cacheReadPrice = pricing[2] ?? inputPrice;
  const cacheWritePrice = pricing[3] ?? inputPrice;

  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const costDelta =
    (uncached / 1_000_000) * inputPrice +
    (cacheRead / 1_000_000) * cacheReadPrice +
    (cacheWrite / 1_000_000) * cacheWritePrice +
    (output / 1_000_000) * outputPrice;

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
    fn({ inputTokens: 0, outputTokens: 0, cost: 0 });
  }
}

/**
 * Fetch conversation list from the REST API.
 *
 * @return {Promise<Array>} Array of conversation objects.
 */
export async function fetchConversations() {
  const { restUrl, nonce } = window.gdsAssistant || {};
  const response = await fetch(`${restUrl}conversations`, {
    headers: { "X-WP-Nonce": nonce },
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
  const { restUrl, nonce } = window.gdsAssistant || {};
  const response = await fetch(`${restUrl}conversations/${uuid}`, {
    headers: { "X-WP-Nonce": nonce },
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
  // Queue of pending tool approvals. Each entry:
  //   {toolUseId, toolName, input}
  // Kept as state (not ref) so mutations trigger re-renders and the
  // Approve/Deny UI appears/disappears correctly. Ordered by arrival.
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const abortRef = useRef(null);
  const onNewRef = useRef(null);

  const onNew = useCallback(async (message) => {
    // Build content blocks from text + attachments
    const contentBlocks = [];

    const userText =
      typeof message.content === "string"
        ? message.content
        : message.content
            ?.map((p) => (p.type === "text" ? p.text : ""))
            .join("") || "";

    // Control messages (approval/denial) — don't show in chat
    const isControlMsg =
      userText.startsWith("__tool_approved__:") ||
      userText.startsWith("__tool_denied__:");

    if (userText && !isControlMsg) {
      contentBlocks.push({ type: "text", text: userText });
    }

    // Process image attachments — prefer URL (uploaded to media library) over base64
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        const contentType = attachment.contentType || "";
        if (!contentType.startsWith("image/")) continue;

        const imageContent = attachment.content?.[0];
        if (!imageContent?.image) continue;

        const imageUrl = imageContent.image;
        const mediaId = imageContent.mediaId;

        if (mediaId || !imageUrl.startsWith("data:")) {
          // Uploaded to media library — use URL (saves context tokens)
          contentBlocks.push({
            type: "image",
            source: { type: "url", url: imageUrl },
          });
          if (mediaId) {
            contentBlocks.push({
              type: "text",
              text: `(Uploaded image — attachment ID: ${mediaId})`,
            });
          }
        } else {
          // Fallback: data URL → extract base64
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            contentBlocks.push({
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            });
          }
        }
      }
    }

    if (!isControlMsg) {
      const userMsg = {
        role: "user",
        content: contentBlocks,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
    }

    setIsRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { restUrl, nonce } = window.gdsAssistant || {};
      // For control messages (approval/denial) the server's detectToolApproval
      // expects the LAST message's content to be a STRING. Don't wrap it in a
      // content-block array — that would make the content non-string and the
      // server would miss the signal, fall into the regular-message branch,
      // and call the LLM again (adding MORE pending approvals to the queue).
      const requestContent = isControlMsg ? userText : contentBlocks;
      const response = await fetch(`${restUrl}chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WP-Nonce": nonce,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: requestContent }],
          conversation_id: currentConversationId || "",
          model: currentModel || "",
          max_tokens: currentMaxTokens || undefined,
          system_context: currentSystemContext || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Chat request failed: ${response.status} ${error}`);
      }

      // Build structured content parts from SSE events.
      // Each agentic turn gets its own assistant message. A "turn" here is
      // one LLM-response cycle: zero-or-more text deltas, zero-or-more tool
      // uses, all their results, then the turn is considered complete when
      // the LLM comes back with NEW text (meaning it's reasoning on the
      // results). We don't flush on every tool_result because the LLM may
      // be running multiple tools in parallel — we'd orphan later results.
      let turnParts = [];
      let currentTextIdx = -1;
      let sawToolResultInTurn = false;

      const ensureTextPart = () => {
        if (currentTextIdx < 0 || turnParts[currentTextIdx]?.type !== "text") {
          currentTextIdx = turnParts.length;
          turnParts.push({ type: "text", text: "" });
        }
        return currentTextIdx;
      };

      // Stable timestamp for the current turn — set when the first event
      // arrives so the embedded timestamp doesn't jitter as deltas stream in.
      let turnTimestamp = null;
      const touchTurnTimestamp = () => {
        if (turnTimestamp === null) {
          turnTimestamp = Date.now();
        }
      };

      /** Flush current turn as an assistant message and start a new turn. */
      const flushTurn = () => {
        if (!turnParts.length) return;
        const contentParts = turnParts.map((p) => ({ ...p }));
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: contentParts,
            timestamp: turnTimestamp ?? Date.now(),
          },
        ]);
        turnParts = [];
        currentTextIdx = -1;
        turnTimestamp = null;
      };

      /** Update the current turn's assistant message in-place (for streaming). */
      const updateCurrentTurn = () => {
        touchTurnTimestamp();
        const contentParts = turnParts.map((p) => ({ ...p }));
        const timestamp = turnTimestamp;
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
            updated[lastIdx] = {
              role: "assistant",
              content: contentParts,
              timestamp: updated[lastIdx].timestamp ?? timestamp,
            };
          } else {
            updated.push({
              role: "assistant",
              content: contentParts,
              timestamp,
            });
          }
          return updated;
        });
      };

      for await (const event of parseSSE(response.body)) {
        switch (event.type) {
          case "text_delta": {
            // If we saw tool results and now text is coming in, the LLM is
            // starting a new reasoning round. Flush the previous turn so the
            // next message is fresh.
            if (sawToolResultInTurn) {
              flushTurn();
              sawToolResultInTurn = false;
            }
            const idx = ensureTextPart();
            turnParts[idx].text += event.data.text;
            break;
          }

          case "tool_use_start": {
            // If the previous round already produced results and the LLM is
            // now invoking another tool (even without text in between), flush
            // so the new round is its own assistant message.
            if (sawToolResultInTurn) {
              flushTurn();
              sawToolResultInTurn = false;
            }
            const idx = ensureTextPart();
            const toolLabel = event.data.name?.replace("__", "/") || "unknown";
            const toolId = event.data.id || "";
            // Compact one-liner — full input in an <abbr title=…> so the
            // browser shows a native tooltip on hover. Markdown processors
            // don't parse markdown inside raw HTML blocks, so we keep the
            // bold/code formatting OUTSIDE the abbr tag and only wrap the
            // tool name. Much simpler than nested <details> which rendered
            // its inner markdown as plain text.
            const inputForTitle =
              event.data.input && Object.keys(event.data.input).length > 0
                ? JSON.stringify(event.data.input, null, 2)
                : "(no arguments)";
            // Escape for the attribute: &quot; and newlines as literal \n
            // survive the HTML sanitizer, which is enough for a tooltip.
            const titleSafe = inputForTitle
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;");
            turnParts[
              idx
            ].text += `\n\n**Tool:** <abbr class="gds-tool" title="${titleSafe}">\`${toolLabel}\`</abbr> _Running..._<!--t:${toolId}-->`;
            break;
          }

          case "tool_result": {
            const idx = ensureTextPart();
            const status = event.data.is_error
              ? "**Error**"
              : "**Done** \u2713";
            const toolId = event.data.tool_use_id || "";

            // Update the abbr title to include the result alongside input
            if (toolId) {
              const resultPreview = event.data.result
                ? JSON.stringify(event.data.result).slice(0, 800)
                : "(empty)";
              const resultSafe = resultPreview
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;");
              // Find the abbr tag associated with this tool call and append result
              const abbrRe = new RegExp(
                `(<abbr class="gds-tool" title=")(.*?)(">)([\\s\\S]*?<!--t:${toolId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`
              );
              const abbrMatch = turnParts[idx].text.match(abbrRe);
              if (abbrMatch) {
                const inputTitle = abbrMatch[2];
                const newTitle = `${inputTitle}\n\n→ ${resultSafe}`;
                turnParts[idx].text = turnParts[idx].text.replace(
                  abbrRe,
                  `$1${newTitle}$3$4`
                );
              }
            }

            const marker = `_Running..._<!--t:${toolId}-->`;
            const pos = toolId ? turnParts[idx].text.indexOf(marker) : -1;
            if (pos !== -1) {
              turnParts[idx].text =
                turnParts[idx].text.slice(0, pos) +
                status +
                turnParts[idx].text.slice(pos + marker.length);
            } else {
              // Fallback for events without an id
              const fallback = turnParts[idx].text.lastIndexOf("_Running..._");
              if (fallback !== -1) {
                const after = turnParts[idx].text.slice(fallback);
                const endOfMarker = after.indexOf("-->");
                const markerLen =
                  endOfMarker !== -1 ? endOfMarker + 3 : "_Running..._".length;
                turnParts[idx].text =
                  turnParts[idx].text.slice(0, fallback) +
                  status +
                  turnParts[idx].text.slice(fallback + markerLen);
              }
            }

            // Drop this tool from the pending-approval queue if it was
            // there (server resolves pending stubs into real results).
            if (event.data.tool_use_id) {
              setPendingApprovals((q) =>
                q.filter((p) => p.toolUseId !== event.data.tool_use_id),
              );
            }
            // Don't flush here — the LLM may be running multiple tools in
            // parallel. Flush only when the LLM continues with new text
            // (handled in `text_delta`) or when the whole response ends.
            sawToolResultInTurn = true;
            break;
          }

          case "tool_approval_required": {
            const idx = ensureTextPart();
            turnParts[
              idx
            ].text += `\n\n**Approval required:** \`${event.data.tool_name}\``;
            if (event.data.input && Object.keys(event.data.input).length > 0) {
              turnParts[idx].text += `\n\`\`\`json\n${JSON.stringify(
                event.data.input,
                null,
                2,
              )}\n\`\`\``;
            }
            turnParts[idx].text += "\n_Waiting for approval..._";
            // Enqueue unless we already have this id (dedupe on resurface).
            setPendingApprovals((q) => {
              if (q.some((p) => p.toolUseId === event.data.tool_use_id)) {
                return q;
              }
              return [
                ...q,
                {
                  toolUseId: event.data.tool_use_id,
                  toolName: event.data.tool_name,
                  input: event.data.input,
                },
              ];
            });
            break;
          }

          case "ask_user": {
            const idx = ensureTextPart();
            turnParts[idx].text += `\n\n> **${
              event.data.question || "Confirm?"
            }**\n`;
            if (event.data.options?.length) {
              turnParts[idx].text += event.data.options
                .map((o) => `> - ${o}`)
                .join("\n");
            }
            turnParts[idx].text += "\n\n_Reply below to continue._\n";
            break;
          }

          case "error": {
            const idx = ensureTextPart();
            turnParts[idx].text += `\n\n**Error:** ${event.data.message}\n`;
            break;
          }

          case "conversation_start":
            if (event.data.conversation_id) {
              currentConversationId = event.data.conversation_id;
            }
            if (event.data.model) {
              currentModel = event.data.model;
            }
            break;

          case "usage":
            emitUsage(
              event.data.input_tokens || 0,
              event.data.output_tokens || 0,
              event.data.cache_read_tokens || 0,
              event.data.cache_write_tokens || 0,
            );
            break;

          case "message_stop":
            break;
        }

        // Update current turn's message in-place for streaming
        if (turnParts.length) {
          updateCurrentTurn();
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: [{ type: "text", text: `**Error:** ${err.message}` }],
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
    // Historical conversations don't have per-turn cache breakdowns, so
    // estimate using full input price. This over-estimates slightly vs real
    // cost (which had cache discounts) but is the safest approximation.
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

    // Build a map of tool_use_id → result content from stored messages
    // so we can show input+output in the abbr tooltip for history.
    const toolResultMap = {};
    for (const m of conv.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
          toolResultMap[block.tool_use_id] = raw.slice(0, 800);
        }
      }
    }

    // Convert stored messages to structured UI format
    const uiMessages = conv.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .reduce((acc, m) => {
        if (m.role === "user") {
          const text =
            typeof m.content === "string"
              ? m.content
              : (m.content || [])
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("");
          if (!text) return acc;
          acc.push({ role: "user", content: [{ type: "text", text }] });
          return acc;
        }

        // Assistant: build structured parts from stored content
        const parts = [];
        const blocks =
          typeof m.content === "string"
            ? [{ type: "text", text: m.content }]
            : Array.isArray(m.content)
            ? m.content
            : [];

        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            parts.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            const toolLabel = (block.name || "").replace("__", "/");
            const inputStr = block.input && Object.keys(block.input).length > 0
              ? JSON.stringify(block.input, null, 2)
              : "(no arguments)";
            const resultStr = toolResultMap[block.id] || "";
            let titleContent = inputStr
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;");
            if (resultStr) {
              titleContent += `\n\n→ ${resultStr
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;")}`;
            }
            const toolText = `\n**Tool:** <abbr class="gds-tool" title="${titleContent}">\`${toolLabel}\`</abbr> **Done** \u2713`;
            parts.push({ type: "text", text: toolText });
          }
        }

        if (!parts.length) return acc;

        acc.push({ role: "assistant", content: parts });
        return acc;
      }, []);

    setMessages(uiMessages);

    // Restore the pending-approval queue from any pending_approval stubs
    // that still exist in stored conversation — so the Approve/Deny UI
    // comes back after a page reload without the user having to send
    // another message first.
    const restored = restorePendingApprovalsFromHistory(conv.messages || []);
    setPendingApprovals(restored);
  }, []);

  const convertMessage = useCallback((msg) => {
    // Convert our server format to assistant-ui's expected format
    const content = (msg.content || []).map((part) => {
      if (part.type === "image" && part.source) {
        // Our format: {type:'image', source:{type:'url',url}} or {type:'base64',data}
        const url =
          part.source.type === "url"
            ? part.source.url
            : `data:${part.source.media_type};base64,${part.source.data}`;
        return { type: "image", image: url };
      }
      return part;
    });
    return {
      role: msg.role,
      content,
      // Pass a real Date when we have a timestamp; use epoch (`new Date(0)`)
      // as a sentinel for "unknown" so assistant-ui's internal
      // `createdAt ?? new Date()` fallback doesn't overwrite undefined with
      // the current time (that made every message render as "now").
      // MessageTimestamp treats epoch as "hide".
      createdAt: msg.timestamp ? new Date(msg.timestamp) : new Date(0),
    };
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
          .find((m) => m.role === "user");
        if (lastUser) {
          const text =
            lastUser.content
              ?.map((p) => (p.type === "text" ? p.text : ""))
              .join("") || "";
          if (text) {
            setTimeout(() => onNew({ content: text }), 0);
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
      accept: "image/png,image/jpeg,image/gif,image/webp",
      async add({ file }) {
        const id = Math.random().toString(36).slice(2);
        const previewUrl = URL.createObjectURL(file);

        // Start upload in background — don't await
        const { nonce, restBase } = window.gdsAssistant || {};
        const formData = new FormData();
        formData.append("file", file);
        uploadPromises.current[id] = fetch(`${restBase}media?gds_assistant=1`, {
          method: "POST",
          headers: { "X-WP-Nonce": nonce },
          body: formData,
        }).then((r) => r.json());

        // Return immediately with local preview
        return {
          id,
          type: "image",
          name: file.name,
          contentType: file.type,
          file,
          status: { type: "requires-action", reason: "composer-send" },
          content: [{ type: "image", image: previewUrl }],
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
              status: { type: "complete" },
              content: [
                { type: "image", image: media.source_url, mediaId: media.id },
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
          status: { type: "complete" },
          content: [
            {
              type: "image",
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

  // Approve/Deny always act on the FIRST pending approval; the server
  // batch-resolves ALL currently-pending stubs when any one is approved or
  // denied (see ChatEndpoint::handleToolApproval), so one click covers the
  // whole queue.
  const approveToolCall = useCallback(() => {
    setPendingApprovals((q) => {
      if (!q.length) return q;
      const [first, ...rest] = q;
      onNewRef.current?.({
        content: `__tool_approved__:${first.toolUseId}`,
      });
      return rest;
    });
  }, []);

  const denyToolCall = useCallback(() => {
    setPendingApprovals((q) => {
      if (!q.length) return q;
      const [first, ...rest] = q;
      onNewRef.current?.({
        content: `__tool_denied__:${first.toolUseId}`,
      });
      return rest;
    });
  }, []);

  const runtime = useExternalStoreRuntime(adapter);

  return {
    runtime,
    loadConversation,
    approveToolCall,
    denyToolCall,
    pendingApprovals,
  };
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Format a timestamp for display in the message-time footer.
 * Same day: `HH:MM` (24h); different day: `MM-DD HH:MM`. sv-SE locale so
 * digits are always 24-hour and the date reads consistently regardless of
 * the browser UI language.
 */
export function formatMessageTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return sameDay
    ? time
    : `${d.toLocaleDateString("sv-SE", {
        month: "2-digit",
        day: "2-digit",
      })} ${time}`;
}

/**
 * Walk stored conversation messages and return pending-approval items so
 * the Approve/Deny UI can be restored on load.
 *
 * Pairs assistant tool_use blocks with the corresponding tool_result block
 * in the NEXT user message, then keeps only ones still in pending_approval
 * state.
 *
 * Exported for tests.
 *
 * @param {Array} rawMessages Raw conversation.messages from the server.
 * @return {Array<{toolUseId, toolName, input}>}
 */
export function restorePendingApprovalsFromHistory(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];

  const out = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

    // Collect tool_use blocks (id → {name, input}) from this assistant msg.
    const toolUses = [];
    for (const block of msg.content) {
      if (block?.type === "tool_use" && block.id) {
        toolUses.push({
          id: block.id,
          name: block.name || "",
          input: block.input || {},
        });
      }
    }
    if (!toolUses.length) continue;

    // The corresponding tool_result blocks should be in the next user msg.
    const next = rawMessages[i + 1];
    const nextBlocks =
      next?.role === "user" && Array.isArray(next.content) ? next.content : [];

    for (const tu of toolUses) {
      const resultBlock = nextBlocks.find(
        (b) => b?.type === "tool_result" && b.tool_use_id === tu.id,
      );
      if (!resultBlock) continue;
      const contentStr =
        typeof resultBlock.content === "string" ? resultBlock.content : "";
      let parsed;
      try {
        parsed = JSON.parse(contentStr);
      } catch {
        parsed = null;
      }
      if (parsed?.status === "pending_approval") {
        out.push({
          toolUseId: tu.id,
          toolName: tu.name.replace("__", "/"),
          input: tu.input,
        });
      }
    }
  }

  return out;
}

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
      const base64 = dataUrl?.split(",")[1] || null;
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
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
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
        } else if (line.trim() === "") {
          eventType = null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
