/**
 * Shared message + SSE event types for the chat runtime.
 *
 * Two distinct shapes live in this codebase:
 *
 * 1. **Wire / storage form** — what the server emits and what we persist in
 *    `ConversationStore`. Mirrors the LLM provider's content-block model:
 *    `text`, `tool_use` (assistant turn), `tool_result` (user turn carrying
 *    tool output), `image`. Used in REST payloads and history hydration.
 *
 * 2. **assistant-ui form** — what the {@link
 *    https://assistant-ui.com/docs ExternalStoreRuntime} renders. Same
 *    information, but `tool_use` + `tool_result` are coalesced into one
 *    `tool-call` part with `result` filled in on completion, and `image`
 *    carries a plain URL ready for `<img>`.
 *
 * The runtime adapter (`use-runtime-adapter`) translates between them.
 * Stored history goes through `wireToAssistantUi()` on load; new chat turns
 * are built directly in the assistant-ui form and then persisted.
 *
 * SSE event types from the chat endpoint are also defined here as a
 * discriminated `RuntimeEvent` union so the adapter's main switch statement
 * narrows on `event.type`.
 */

// ── Wire / storage content blocks ───────────────────────────

export interface WireTextBlock {
  type: "text";
  text: string;
}

export interface WireToolUseBlock {
  type: "tool_use";
  /** Stable id the model assigned; pairs with the matching `tool_use_id`. */
  id: string;
  /** Tool name in `namespace__slug` form (server schema). */
  name: string;
  /** Arguments JSON the model produced. */
  input: Record<string, unknown>;
}

export interface WireToolResultBlock {
  type: "tool_result";
  /** References the `WireToolUseBlock.id` this result belongs to. */
  tool_use_id: string;
  /** Either a string (truncated/raw) or a structured payload. */
  content: string | Record<string, unknown>;
  is_error?: boolean;
}

/**
 * Image attachment in the wire form. We pass through the provider's `source`
 * shape — Anthropic's `{type: 'base64', media_type, data}` for inline bytes
 * or `{type: 'url', url}` for hosted images — both supported by the chat
 * endpoint's `normalizeMessages()`.
 */
export interface WireImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export type WireContentBlock =
  | WireTextBlock
  | WireToolUseBlock
  | WireToolResultBlock
  | WireImageBlock;

/** Conversation message as stored + sent over REST. */
export interface WireMessage {
  role: "user" | "assistant" | "system";
  content: string | WireContentBlock[];
  /** Display-only millisecond timestamp the UI carries on stored messages. */
  ts?: number;
}

// ── assistant-ui content parts ──────────────────────────────

export interface UiTextPart {
  type: "text";
  text: string;
}

/**
 * Merged tool_use + tool_result. `result` is undefined while the tool is
 * running (drives the "Running..." badge); becomes a string or structured
 * payload when the server emits `tool_result`. `isError` flips the badge
 * red and tells `ToolCallFallback` to render the error variant.
 */
export interface UiToolCallPart {
  type: "tool-call";
  /** Mirrors the wire `tool_use_id`. */
  toolCallId: string;
  /** Tool name in `namespace/slug` form (assistant-ui style). */
  toolName: string;
  args: Record<string, unknown>;
  result?: string | Record<string, unknown>;
  isError?: boolean;
}

export interface UiImagePart {
  type: "image";
  image: string;
  /** Attachment id if the image came from the media library. */
  mediaId?: number;
}

export type UiContentPart = UiTextPart | UiToolCallPart | UiImagePart;

/** Message shape assistant-ui's `ExternalStoreRuntime` consumes. */
export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string | UiContentPart[];
  /** Optional millisecond timestamp; surfaced by message-time hooks. */
  timestamp?: number;
}

// ── SSE events from /chat ───────────────────────────────────

/** Conversation id + active model — sent once at the top of each stream. */
export interface ConversationStartEvent {
  type: "conversation_start";
  data: { conversation_id?: string; model?: string };
}

export interface TextDeltaEvent {
  type: "text_delta";
  data: { text: string };
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  data: {
    id: string;
    name: string;
    input?: Record<string, unknown>;
  };
}

export interface ToolResultEvent {
  type: "tool_result";
  data: {
    tool_use_id: string;
    result?: string | Record<string, unknown>;
    is_error?: boolean;
    /** Reversible? Drives the Undo button in `ToolCallFallback`. */
    undoable?: boolean;
    /** Audit row id passed back to the `/undo` endpoint. */
    audit_id?: number;
    /** Human label rendered on the Undo button (e.g. "Restore post"). */
    undo_label?: string;
  };
}

/**
 * Destructive tool waiting on a user click. Modal mounts an approval card;
 * the next chat request POSTs `__tool_approved__:<id>` / denied to resume.
 */
export interface ToolApprovalRequiredEvent {
  type: "tool_approval_required";
  data: {
    tool_use_id: string;
    tool_name: string;
    input?: Record<string, unknown>;
    /** Hostname the user can mark as "trust this host" on approval. */
    trustable_host?: string | null;
  };
}

/**
 * Server is delegating an `editor__*` tool to the browser. We execute it
 * via `editor-bridge.executeClientTool` and POST results back to
 * resume the loop.
 */
export interface ClientToolCallEvent {
  type: "client_tool_call";
  data: {
    tool_use_id: string;
    tool_name: string;
    input?: Record<string, unknown>;
  };
}

/** Free-form question prompting the user (multiple-choice or open). */
export interface AskUserEvent {
  type: "ask_user";
  data: {
    question?: string;
    options?: string[];
  };
}

/**
 * Token + cost accounting. Cache fields are subsets of `input_tokens`;
 * Anthropic emits both `cache_read_tokens` and `cache_write_tokens`,
 * other providers typically only `cache_read_tokens`.
 */
export interface UsageEvent {
  type: "usage";
  data: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface ErrorEvent {
  type: "error";
  data: { message?: string };
}

export interface MessageStopEvent {
  type: "message_stop";
  data: Record<string, never>;
}

/** Discriminated union of every event the chat endpoint emits. */
export type RuntimeEvent =
  | ConversationStartEvent
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolResultEvent
  | ToolApprovalRequiredEvent
  | ClientToolCallEvent
  | AskUserEvent
  | UsageEvent
  | ErrorEvent
  | MessageStopEvent;

// ── Session usage tracker (emitted by emitUsage / onUsageUpdate) ──

export interface SessionUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
