import { useExternalStoreRuntime } from "@assistant-ui/react";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "@wordpress/element";
import { getEditorContext, executeClientTool } from "../editor/editor-bridge";

// Session state
let currentConversationId = null;
let currentModel = localStorage.getItem("gds-assistant-model") || "";
let currentMaxTokens =
  parseInt(localStorage.getItem("gds-assistant-max-tokens"), 10) || 0;
let currentSystemContext = "";

// Cap consecutive client-tool resumes (each is its own request, so the
// server's per-request iteration limit doesn't bound the chain). Stops a model
// that keeps calling editor tools without converging.
const MAX_CLIENT_TOOL_ROUNDTRIPS = 12;

// Persist the active conversation across full-page wp-admin navigations so the
// chat can reopen on the same thread. Cleared by newChat().
const ACTIVE_CONVERSATION_KEY = "gds-assistant-active-conversation";

function persistConversationId(id) {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}

export function getPersistedConversationId() {
  try {
    return localStorage.getItem(ACTIVE_CONVERSATION_KEY) || null;
  } catch {
    return null;
  }
}

// Stable, unique ids for messages so assistant-ui keys them consistently
// (prevents remounts on unrelated re-renders) and so a streaming turn can own
// its message by id rather than by position.
let messageIdSeq = 0;
function nextMessageId() {
  messageIdSeq += 1;
  return `gds-msg-${Date.now().toString(36)}-${messageIdSeq.toString(36)}`;
}

const sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  listeners: new Set(),
};

// What the assistant is doing right now, so the indicator can say more than
// "•••". Updated as SSE events arrive and while client tools run.
const runStatus = { text: "", listeners: new Set() };

function setRunStatus(text) {
  if (runStatus.text === text) {
    return;
  }
  runStatus.text = text;
  for (const fn of runStatus.listeners) {
    fn(text);
  }
}

export function onRunStatus(callback) {
  runStatus.listeners.add(callback);
  callback(runStatus.text);
  return () => runStatus.listeners.delete(callback);
}

// Human phase label for a tool name (either "editor__x" or "editor/x" form).
function toolStatusLabel(name) {
  const key = (name || "").replace("/", "__");
  const map = {
    editor__read_selection: "Reading the editor",
    editor__replace_blocks: "Editing the document",
    editor__insert_blocks: "Inserting blocks",
    editor__update_block_attributes: "Updating a block",
    editor__update_post: "Updating the post",
    editor__recover_block: "Recovering blocks",
    editor__query_dom: "Inspecting the page",
    editor__focus: "Locating that",
    editor__open_sidebar: "Opening a panel",
  };
  return map[key] || `Running ${(name || "tool").replace("__", "/")}`;
}

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
 * @param {number} input      Total input tokens (includes cached)
 * @param {number} output     Output tokens
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
  persistConversationId(null);
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
  if (!response.ok) {
    return [];
  }
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
  if (!response.ok) {
    return null;
  }
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
  // Map of tool_use_id -> { auditId, label, undone, caveats?, error? } for
  // actions the server reported as reversible. Drives the per-tool Undo button.
  const [undoableActions, setUndoableActions] = useState({});
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

    // Control messages (approval/denial, editor-tool results) — don't show in chat
    const clientToolResults = Array.isArray(message.clientToolResults)
      ? message.clientToolResults
      : null;
    const isControlMsg =
      userText.startsWith("__tool_approved__:") ||
      userText.startsWith("__tool_denied__:") ||
      !!clientToolResults;

    if (userText && !isControlMsg) {
      contentBlocks.push({ type: "text", text: userText });
    }

    // Process image attachments — prefer URL (uploaded to media library) over base64
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        const contentType = attachment.contentType || "";
        if (!contentType.startsWith("image/")) {
          continue;
        }

        const imageContent = attachment.content?.[0];
        if (!imageContent?.image) {
          continue;
        }

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
        id: nextMessageId(),
        role: "user",
        content: contentBlocks,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
    }

    setIsRunning(true);
    setRunStatus("Thinking…");
    const controller = new AbortController();
    abortRef.current = controller;
    // When we chain into a client-tool resume, the resume's own send owns the
    // running state — don't let this stream's finally clear it.
    let resuming = false;

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
          // Live block-editor state — enables the editor_* client tools.
          editor_context: getEditorContext(),
          // Present only when resuming after browser-executed editor tools.
          client_tool_results: clientToolResults || undefined,
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
      // Editor tools the server asked the browser to run this stream. Executed
      // after the stream ends, then their results are POSTed back to resume.
      const pendingClientCalls = [];

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

      // Whether the CURRENT turn already owns a message in `messages`. A fresh
      // stream (notably the follow-up after a tool approval) starts without
      // one, so its first content must PUSH a new message rather than overwrite
      // the previous turn's — otherwise the approval turn's tool-call card gets
      // wiped by the "Done"/result text that follows.
      // We key the turn's message by id (not "the last assistant message" or a
      // mutable flag): setMessages updaters run batched/deferred, so a flag they
      // read would be stale by the time React flushes them.
      let currentTurnMessageId = null;

      /** Seal the current turn so the next content starts a new message. */
      const flushTurn = () => {
        currentTurnMessageId = null;
        turnParts = [];
        currentTextIdx = -1;
        turnTimestamp = null;
      };

      /** Render the current turn's parts into its own assistant message. */
      const updateCurrentTurn = () => {
        if (!turnParts.length) {
          return;
        }
        touchTurnTimestamp();
        const contentParts = turnParts.map((p) => ({ ...p }));
        const timestamp = turnTimestamp;
        if (!currentTurnMessageId) {
          currentTurnMessageId = nextMessageId();
        }
        const msgId = currentTurnMessageId;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msgId);
          const assistantMessage = {
            id: msgId,
            role: "assistant",
            content: contentParts,
            timestamp: (idx >= 0 ? prev[idx].timestamp : null) ?? timestamp,
          };
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = assistantMessage;
            return updated;
          }
          return [...prev, assistantMessage];
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
            // Text is streaming in and visible — the dots alone now mean
            // "responding", so drop the phase label.
            setRunStatus("");
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
            const toolLabel = event.data.name?.replace("__", "/") || "unknown";
            const toolId = event.data.id || "";
            setRunStatus(toolStatusLabel(event.data.name));
            // Emit a real tool-call content part — assistant-ui renders it via
            // the ToolCallUI component (ToolCallFallback), which shows running/
            // done/error state and (when undoable) an Undo button.
            turnParts.push({
              type: "tool-call",
              toolCallId: toolId,
              toolName: toolLabel,
              args:
                event.data.input && typeof event.data.input === "object"
                  ? event.data.input
                  : {},
            });
            // Any text after this tool starts a fresh text part.
            currentTextIdx = -1;
            updateCurrentTurn();
            break;
          }

          case "tool_result": {
            const toolId = event.data.tool_use_id || "";

            // Attach the result to the matching tool-call part so it flips
            // from "Running" to Done/Error. Match the first part that's still
            // unfilled, so when a model reuses one id across calls each result
            // lands on its own card rather than all stacking on the first.
            const tc = toolId
              ? turnParts.find(
                  (p) =>
                    p.type === "tool-call" &&
                    p.toolCallId === toolId &&
                    p.result === undefined,
                )
              : null;
            if (tc) {
              tc.result = event.data.result ?? {};
              tc.isError = !!event.data.is_error;
            } else if (toolId) {
              // Approval flow: the tool-call card lives in an earlier, already
              // rendered message (the approval turn), not this fresh turn.
              // Update the first unfilled match in place so it flips from
              // "Approval required" to Done/Error and the Undo button appears.
              let patched = false;
              setMessages((prev) =>
                prev.map((m) => {
                  if (
                    patched ||
                    m.role !== "assistant" ||
                    !Array.isArray(m.content)
                  ) {
                    return m;
                  }
                  let changed = false;
                  const content = m.content.map((p) => {
                    if (
                      !patched &&
                      p.type === "tool-call" &&
                      p.toolCallId === toolId &&
                      p.result === undefined
                    ) {
                      patched = true;
                      changed = true;
                      return {
                        ...p,
                        result: event.data.result ?? {},
                        isError: !!event.data.is_error,
                      };
                    }
                    return p;
                  });
                  return changed ? { ...m, content } : m;
                }),
              );
            }

            // Record undo info (keyed by tool id) so ToolCallFallback can show
            // an Undo button. Only present when the action is reversible.
            if (event.data.undoable && event.data.audit_id && toolId) {
              setUndoableActions((prev) => ({
                ...prev,
                [toolId]: {
                  auditId: event.data.audit_id,
                  label: event.data.undo_label || "Undo this action",
                  undone: false,
                },
              }));
            }

            // Drop this tool from the pending-approval queue if it was
            // there (server resolves pending stubs into real results).
            if (toolId) {
              setPendingApprovals((q) =>
                q.filter((p) => p.toolUseId !== toolId),
              );
            }
            // Only advance the current turn when the result belonged to THIS
            // turn. In the approval flow the result patched an earlier message,
            // so touching the current (empty) turn would render a stray bubble.
            if (tc) {
              // Don't flush here — the LLM may be running multiple tools in
              // parallel. Flush only when the LLM continues with new text
              // (handled in `text_delta`) or when the whole response ends.
              sawToolResultInTurn = true;
              updateCurrentTurn();
            }
            break;
          }

          case "tool_approval_required": {
            const toolLabel =
              event.data.tool_name?.replace("__", "/") || "unknown";
            const toolId = event.data.tool_use_id || "";
            // The provider already emitted tool_use_start for this tool, so a
            // card usually exists — approval just flags it (via pendingApprovals
            // → context). Only mint a card if one isn't there yet; pushing a
            // second would leave a duplicate stuck on "Running" after approval.
            const existingCard =
              toolId &&
              turnParts.find(
                (p) => p.type === "tool-call" && p.toolCallId === toolId,
              );
            const approvalInput =
              event.data.input && typeof event.data.input === "object"
                ? event.data.input
                : {};
            if (!existingCard) {
              turnParts.push({
                type: "tool-call",
                toolCallId: toolId,
                toolName: toolLabel,
                args: approvalInput,
              });
              currentTextIdx = -1;
              updateCurrentTurn();
            } else if (Object.keys(approvalInput).length > 0) {
              // tool_use_start may have carried empty input — fill the real args.
              existingCard.args = approvalInput;
              updateCurrentTurn();
            }
            // Enqueue unless we already have this id (dedupe on resurface).
            setPendingApprovals((q) => {
              if (q.some((p) => p.toolUseId === toolId)) {
                return q;
              }
              return [
                ...q,
                {
                  toolUseId: toolId,
                  toolName: event.data.tool_name,
                  input: event.data.input,
                  trustableHost: event.data.trustable_host || null,
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
              persistConversationId(currentConversationId);
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

          case "client_tool_call":
            // The server wants the browser to run an editor tool. The matching
            // tool-call card already exists (from tool_use_start); just queue
            // the op — we execute after the stream ends and POST results back.
            if (event.data.tool_use_id) {
              pendingClientCalls.push({
                toolUseId: event.data.tool_use_id,
                toolName: event.data.tool_name,
                input: event.data.input || {},
              });
            }
            break;

          case "message_stop":
            break;
        }

        // Update current turn's message in-place for streaming
        if (turnParts.length) {
          updateCurrentTurn();
        }
      }

      // Run any editor tools the server delegated, then resume the loop by
      // POSTing their results (mirrors the human-approval round-trip). Each
      // resume is a fresh request, so cap the chain — otherwise a model that
      // keeps calling editor tools without finishing loops indefinitely.
      if (pendingClientCalls.length) {
        const depth = (message.clientToolDepth || 0) + 1;
        if (depth > MAX_CLIENT_TOOL_ROUNDTRIPS) {
          setMessages((prev) => [
            ...prev,
            {
              id: nextMessageId(),
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "⚠ Stopped: too many editor actions in a row without finishing. Please refine the request or select the block to edit.",
                },
              ],
              timestamp: Date.now(),
            },
          ]);
        } else {
          const results = [];
          for (const call of pendingClientCalls) {
            setRunStatus(toolStatusLabel(call.toolName));
            const result = await executeClientTool(call.toolName, call.input);
            results.push({
              tool_use_id: call.toolUseId,
              result,
              is_error: !!(result && result.error),
            });
          }
          resuming = true;
          onNewRef.current?.({
            content: "__client_result__",
            clientToolResults: results,
            clientToolDepth: depth,
          });
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMessageId(),
            role: "assistant",
            content: [{ type: "text", text: `**Error:** ${err.message}` }],
          },
        ]);
      }
    } finally {
      // If we handed off to a client-tool resume, let that send manage the
      // running state + abort controller instead of tearing them down here.
      if (!resuming) {
        setIsRunning(false);
        setRunStatus("");
        abortRef.current = null;
      }
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
    persistConversationId(uuid);

    if (!uuid) {
      setMessages([]);
      return;
    }

    const conv = await fetchConversation(uuid);
    if (!conv?.messages?.length) {
      // The conversation is gone (e.g. deleted) — drop the stale pointer so we
      // don't keep trying to restore it on future page loads.
      currentConversationId = null;
      persistConversationId(null);
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
      if (m.role !== "user" || !Array.isArray(m.content)) {
        continue;
      }
      for (const block of m.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const raw =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content || "");
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
          if (!text) {
            return acc;
          }
          acc.push({
            id: nextMessageId(),
            role: "user",
            content: [{ type: "text", text }],
            timestamp: m.ts || undefined,
          });
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
            // Restore as a real tool-call part (matching the live stream).
            // No Undo button on history — the stored conversation doesn't
            // carry the audit-log id; undo is offered on live actions only.
            let result = toolResultMap[block.id] || "";
            try {
              result = result ? JSON.parse(result) : {};
            } catch (e) {
              /* keep the raw string if it isn't JSON */
            }
            parts.push({
              type: "tool-call",
              toolCallId: block.id,
              toolName: (block.name || "").replace("__", "/"),
              args: block.input || {},
              result,
            });
          }
        }

        if (!parts.length) {
          return acc;
        }

        acc.push({
          id: nextMessageId(),
          role: "assistant",
          content: parts,
          timestamp: m.ts || undefined,
        });
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
    // assistant-ui keys content parts by toolCallId and throws "Duplicate key
    // … in tapResources" if two collide in one message. Some models/connectors
    // (seen with Gemini) reuse a single tool id across distinct calls in a
    // turn, so suffix repeats to keep React keys unique without dropping any.
    const seenToolIds = new Set();
    const content = (msg.content || []).map((part) => {
      if (part.type === "image" && part.source) {
        // Our format: {type:'image', source:{type:'url',url}} or {type:'base64',data}
        const url =
          part.source.type === "url"
            ? part.source.url
            : `data:${part.source.media_type};base64,${part.source.data}`;
        return { type: "image", image: url };
      }
      if (part.type === "tool-call") {
        let toolCallId = part.toolCallId || "";
        if (toolCallId && seenToolIds.has(toolCallId)) {
          let n = 2;
          while (seenToolIds.has(`${toolCallId}#${n}`)) {
            n++;
          }
          toolCallId = `${toolCallId}#${n}`;
        }
        seenToolIds.add(toolCallId);
        return {
          type: "tool-call",
          toolCallId,
          toolName: part.toolName,
          args: part.args || {},
          argsText: JSON.stringify(part.args || {}),
          result: part.result,
          isError: part.isError,
        };
      }
      return part;
    });
    return {
      id: msg.id,
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
        if (!parentId) {
          return [];
        }
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

  // Expose hooks for external integrations (e.g. the Gutenberg block toolbar)
  // to send a chat message as the user and open the chat panel. Attached to
  // window.gdsAssistant alongside the localized config — both keys are added,
  // the localized properties are preserved.
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    window.gdsAssistant = window.gdsAssistant || {};
    window.gdsAssistant.sendChatMessage = (text) => {
      if (typeof text !== "string" || !text.trim()) {
        return;
      }
      onNewRef.current?.({ content: text });
    };
    window.gdsAssistant.openChat = () => {
      const trigger = document.querySelector(".gds-assistant__trigger");
      if (trigger && trigger.getAttribute("data-state") !== "open") {
        trigger.click();
      }
    };
    return () => {
      if (!window.gdsAssistant) {
        return;
      }
      delete window.gdsAssistant.sendChatMessage;
      delete window.gdsAssistant.openChat;
    };
  }, []);

  // Approve/Deny always act on the FIRST pending approval; the server
  // batch-resolves ALL currently-pending stubs when any one is approved or
  // denied (see ChatEndpoint::handleToolApproval), so one click covers the
  // whole queue.
  const approveToolCall = useCallback((options = {}) => {
    setPendingApprovals((q) => {
      if (!q.length) {
        return q;
      }
      const [first] = q;
      // If the user clicked "Approve & trust domain", append a |trust:HOST
      // suffix so the server can persist the host to the trusted list.
      const trust =
        options.trustHost && first.trustableHost
          ? `|trust:${first.trustableHost}`
          : "";
      onNewRef.current?.({
        content: `__tool_approved__:${first.toolUseId}${trust}`,
      });
      // The server batch-resolves the WHOLE pending queue from one approval
      // (see ChatEndpoint::handleToolApproval), so clear all of it — not just
      // the first — otherwise the approval bar lingers for the siblings.
      // If anything is still genuinely pending server-side, the next message
      // re-surfaces it (resurfacePendingApprovals).
      return [];
    });
  }, []);

  const denyToolCall = useCallback(() => {
    setPendingApprovals((q) => {
      if (!q.length) {
        return q;
      }
      const [first] = q;
      onNewRef.current?.({
        content: `__tool_denied__:${first.toolUseId}`,
      });
      // Denial is batch-resolved server-side too — clear the whole queue.
      return [];
    });
  }, []);

  // Retry a single failed tool call by re-executing it with the same args.
  // Currently supports CLIENT-executed tools only (editor__* operate on the
  // live block editor); for server-side tools the user gets a clear message
  // because real retry requires a new backend round-trip (see #38 for the
  // server-side proposal).
  //
  // Behaviour:
  //  - Patches the failed tool-call part in-place: replaces result + isError
  //    on success, replaces just result if the retry also fails.
  //  - The LLM sees the retried result in the conversation history on its
  //    next turn — no auto-resend, no re-prompt.
  const [retryingIds, setRetryingIds] = useState(() => new Set());
  const retryToolCall = useCallback(
    async (toolCallId) => {
      if (!toolCallId) {
        return;
      }

      // Locate the tool-call part across the message history. Iterate from the
      // end since retries are almost always on the most recent error.
      let target = null;
      let messageId = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const part = (m.content || []).find(
          (p) => p.type === "tool-call" && p.toolCallId === toolCallId,
        );
        if (part) {
          target = part;
          messageId = m.id;
          break;
        }
      }
      if (!target) {
        return;
      }

      // Only client-executed tools can be safely retried locally. Server tools
      // are part of the LLM stream's tool-use cycle and need a fresh backend
      // round-trip to replay — outside this PR's scope.
      if (!target.toolName?.startsWith("editor__")) {
        // eslint-disable-next-line no-alert
        window.alert(
          `Retry is currently supported for client-side editor tools only.\n\n` +
            `For "${target.toolName}", please re-send the original prompt or ` +
            `edit your message and resend.`,
        );
        return;
      }

      setRetryingIds((s) => {
        const next = new Set(s);
        next.add(toolCallId);
        return next;
      });
      try {
        const newResult = await executeClientTool(target.toolName, target.args);
        const isError = !!(newResult && newResult.error);

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) {
              return m;
            }
            return {
              ...m,
              content: (m.content || []).map((p) =>
                p.type === "tool-call" && p.toolCallId === toolCallId
                  ? { ...p, result: newResult, isError }
                  : p,
              ),
            };
          }),
        );
      } catch (e) {
        // Re-execution threw (rather than returning an error result) — surface
        // it as the new result so the user can see what changed.
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) {
              return m;
            }
            return {
              ...m,
              content: (m.content || []).map((p) =>
                p.type === "tool-call" && p.toolCallId === toolCallId
                  ? { ...p, result: { error: String(e) }, isError: true }
                  : p,
              ),
            };
          }),
        );
      } finally {
        setRetryingIds((s) => {
          const next = new Set(s);
          next.delete(toolCallId);
          return next;
        });
      }
    },
    [messages],
  );

  // Undo a single past action by its audit-log id. Direct REST call (no chat
  // turn) — see Api\UndoEndpoint. Updates the per-tool undo state so the
  // button can show "Undone" / surface caveats.
  const undoAction = useCallback(async (toolCallId, auditId) => {
    const { restUrl, nonce } = window.gdsAssistant || {};
    setUndoableActions((prev) =>
      prev[toolCallId]
        ? {
            ...prev,
            [toolCallId]: { ...prev[toolCallId], pending: true, error: null },
          }
        : prev,
    );
    try {
      const res = await fetch(`${restUrl}undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WP-Nonce": nonce },
        body: JSON.stringify({ id: auditId }),
      });
      const data = await res.json().catch(() => ({}));
      setUndoableActions((prev) => {
        if (!prev[toolCallId]) {
          return prev;
        }
        const entry =
          res.ok && data.undone
            ? {
                ...prev[toolCallId],
                pending: false,
                undone: true,
                caveats: data.caveats || [],
              }
            : {
                ...prev[toolCallId],
                pending: false,
                error: data.error || "Undo failed",
              };
        return { ...prev, [toolCallId]: entry };
      });
      // Show the reversal in the thread too (the server records the same note
      // in the conversation + audit log; see Api\UndoEndpoint).
      if (res.ok && data.undone) {
        const label = data.detail || "a previous action";
        const caveats = Array.isArray(data.caveats) ? data.caveats : [];
        const note = `↩ Reverted: ${label}${
          caveats.length ? ` — ${caveats.join(" ")}` : ""
        }`;
        setMessages((prev) => [
          ...prev,
          {
            id: nextMessageId(),
            role: "user",
            content: [{ type: "text", text: note }],
            timestamp: Date.now(),
          },
        ]);
      }
    } catch (e) {
      setUndoableActions((prev) =>
        prev[toolCallId]
          ? {
              ...prev,
              [toolCallId]: {
                ...prev[toolCallId],
                pending: false,
                error: String(e),
              },
            }
          : prev,
      );
    }
  }, []);

  const runtime = useExternalStoreRuntime(adapter);

  return {
    runtime,
    loadConversation,
    approveToolCall,
    denyToolCall,
    pendingApprovals,
    undoableActions,
    undoAction,
    retryToolCall,
    retryingIds,
  };
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Format a timestamp for display in the message-time footer.
 * Same day: `HH:MM` (24h); different day: `MM-DD HH:MM`. sv-SE locale so
 * digits are always 24-hour and the date reads consistently regardless of
 * the browser UI language.
 * @param ts
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
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const out = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

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
    if (!toolUses.length) {
      continue;
    }

    // The corresponding tool_result blocks should be in the next user msg.
    const next = rawMessages[i + 1];
    const nextBlocks =
      next?.role === "user" && Array.isArray(next.content) ? next.content : [];

    for (const tu of toolUses) {
      const resultBlock = nextBlocks.find(
        (b) => b?.type === "tool_result" && b.tool_use_id === tu.id,
      );
      if (!resultBlock) {
        continue;
      }
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
      if (done) {
        break;
      }

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
