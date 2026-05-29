/**
 * Message rendering for the chat thread.
 *
 * Exports the components assistant-ui needs to slot into ThreadPrimitive
 * (UserMessage, AssistantMessage) plus the helpers other parts of the modal
 * reuse (copyToClipboard for the Thread's "Copy transcript" button).
 *
 * Co-located here because they share three small dependencies:
 *   - SYSTEM_NOTE_MARKER for distinguishing out-of-band notes
 *   - BlockChip / BLOCK_REF_RE for rendering "(block <uuid>)" mentions
 *   - the MessageTimestamp footer
 *
 * Tool-call rendering happens in {@link ./ToolCallFallback#ToolCallFallback};
 * AssistantMessage just wires it into MessagePrimitive.Content.
 */

import { MessagePrimitive, useMessage } from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { useCallback, useState } from "@wordpress/element";

import { formatMessageTime } from "../hooks/use-runtime-adapter";
import { ToolCallFallback } from "./ToolCallFallback";

function MessageImage({ image }) {
  if (!image) {
    return null;
  }
  return (
    <img src={image} alt="Attached" className="gds-assistant__message-image" />
  );
}

// Out-of-band notes (e.g. the Undo button's "↩ Reverted…") are stored as user
// messages so the model sees them, but render as a centered system line rather
// than a user bubble. The leading ↩ is our marker.
const SYSTEM_NOTE_MARKER = "↩";

export function UserMessage() {
  const systemNote = useMessage((s) => {
    const text = (s.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("")
      .trim();
    return text.startsWith(SYSTEM_NOTE_MARKER) ? text : null;
  });

  if (systemNote) {
    return <div className="gds-assistant__system-note">{systemNote}</div>;
  }

  return (
    <MessagePrimitive.Root className="gds-assistant__message gds-assistant__message--user">
      <MessagePrimitive.Content
        components={{ Text: UserMessageText, Image: MessageImage }}
      />
      <MessageTimestamp />
    </MessagePrimitive.Root>
  );
}

/**
 * Tiny timestamp rendered at the bottom of a message. We rely on the
 * thread-level <TypingIndicator/> for "assistant is typing" feedback
 * instead of per-message dots — otherwise both indicators show at once.
 *
 * Messages with the epoch sentinel `createdAt` (our "unknown timestamp"
 * marker for older DB rows without per-message timing) render nothing.
 * We also hide the timestamp on messages that haven't finished streaming,
 * so the empty/partial assistant bubble doesn't display a misleading
 * timestamp before the content has arrived.
 */
function MessageTimestamp() {
  const createdAt = useMessage((s) => s.createdAt);
  const isRunning = useMessage((s) => s.status?.type === "running");
  const isLast = useMessage((s) => s.isLast);
  const role = useMessage((s) => s.role);

  // Streaming assistant message: no time yet — TypingIndicator covers it.
  if (isRunning && isLast && role === "assistant") {
    return null;
  }

  if (!createdAt || new Date(createdAt).getTime() < 100000) {
    return null;
  }
  const date = new Date(createdAt);
  return (
    <span
      className="gds-assistant__message-time"
      title={date.toLocaleString("sv-SE")}
    >
      {formatMessageTime(date.getTime())}
    </span>
  );
}

/**
 * Replace any "(block <clientId>)" / "(clientId: <id>)" mentions in a user
 * message with a compact chip — keeps the conversation readable when the
 * model is targeted at a specific block via the toolbar dropdowns or Cmd+J
 * shortcut. Clicking the chip scrolls + selects that block in the editor.
 */
// Two accepted shapes:
//   (block <uuid>)                 — clientId only (we look up the label live)
//   (block <uuid> — paragraph)     — clientId + cached label (chip stays
//                                    accurate even after the block is gone)
const BLOCK_REF_RE =
  /\((?:block|clientId)[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s+[—–-]\s+([^)]+))?\)/gi;

function BlockChip({ clientId, cachedLabel }) {
  const liveName =
    window.wp?.data?.select?.("core/block-editor")?.getBlockName?.(clientId) ||
    "";
  // Prefer the live block name (reflects renames + lookups by id), fall
  // back to the cached label captured when the chip was first inserted,
  // then a generic "block" so the chip never reads as empty.
  let label;
  if (liveName) {
    label = liveName.replace(/^core\//, "").replace(/-/g, " ");
  } else if (cachedLabel) {
    label = cachedLabel.trim();
  } else {
    label = "block";
  }
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const sel = `[data-block="${clientId}"]`;
      const inMain = document.querySelector(sel);
      if (inMain) {
        inMain.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        const iframe = document.querySelector('iframe[name="editor-canvas"]');
        iframe?.contentDocument
          ?.querySelector(sel)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      window.wp?.data?.dispatch?.("core/block-editor")?.selectBlock?.(clientId);
    } catch {
      // Ignore — block may be gone after later edits.
    }
  };
  return (
    <button
      type="button"
      className="gds-assistant__block-chip"
      onClick={onClick}
      title={`Click to focus this block (${clientId})`}
    >
      <svg
        className="gds-assistant__block-chip-icon"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <line x1="4" y1="12" x2="20" y2="12" />
      </svg>
      {label}
    </button>
  );
}

function renderTextWithBlockChips(text) {
  const out = [];
  let last = 0;
  let m;
  BLOCK_REF_RE.lastIndex = 0;
  while ((m = BLOCK_REF_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    out.push({ chip: m[1], cached: m[2] || null, key: `${m.index}-${m[1]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  if (out.length === 1 && typeof out[0] === "string") {
    return null;
  }
  return out;
}

function UserMessageText({ text }) {
  // Long skill prompts: show collapsed with expand toggle
  const isLong = text.length > 200;
  const [expanded, setExpanded] = useState(!isLong);

  const renderText = (raw) => {
    const parts = renderTextWithBlockChips(raw);
    if (!parts) {
      return raw;
    }
    return parts.map((p, i) =>
      typeof p === "string" ? (
        <span key={i}>{p}</span>
      ) : (
        <BlockChip key={p.key} clientId={p.chip} cachedLabel={p.cached} />
      ),
    );
  };

  if (!isLong) {
    return <p style={{ whiteSpace: "pre-wrap" }}>{renderText(text)}</p>;
  }

  // Also strip block clientIds from the truncated preview — otherwise long
  // messages keep showing the raw UUID even when chips render in the full
  // expansion. Truncation runs first, regex second, so a cut-off chip
  // gracefully degrades to plain text instead of breaking layout.
  return (
    <div>
      <p style={{ whiteSpace: "pre-wrap" }}>
        {expanded ? renderText(text) : renderText(text.slice(0, 120) + "...")}
      </p>
      <button
        type="button"
        className="gds-assistant__expand-btn"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Show less" : "Show full prompt"}
      </button>
    </div>
  );
}

export function AssistantMessage() {
  // assistant-ui injects an empty assistant message while a stream warms up.
  // Don't render an empty bubble (with its copy button) for it — the
  // thread-level TypingIndicator covers that gap. We render once there's any
  // real content (text, a tool call, or an image).
  const isEmpty = useMessage((s) => {
    const parts = s.content || [];
    return !parts.some(
      (p) =>
        (p.type === "text" && p.text && p.text.trim()) ||
        p.type === "tool-call" ||
        p.type === "image",
    );
  });
  if (isEmpty) {
    return null;
  }

  return (
    <MessagePrimitive.Root className="gds-assistant__message gds-assistant__message--assistant">
      <CopyMessageButton />
      <MessagePrimitive.Content
        components={{
          Text: AssistantMessageText,
          // assistant-ui routes tool-call parts through `tools.Fallback`
          // (not `ToolCallUI` — that key was a no-op, which is why tool calls
          // previously only appeared as the adapter's inline text).
          tools: { Fallback: ToolCallFallback },
        }}
      />
      <MessageTimestamp />
    </MessagePrimitive.Root>
  );
}

// Extra HTML tags we emit inside assistant messages. Streamdown's default
// sanitize schema strips these, so we need to permit them explicitly with
// the attributes we use. We hover-style the tool-call `<abbr>` via CSS so
// the native browser tooltip still appears on the title attribute.
const STREAMDOWN_ALLOWED_TAGS = {
  abbr: ["class", "title"],
};

function AssistantMessageText({ text }) {
  return (
    <StreamdownTextPrimitive
      text={text}
      allowedTags={STREAMDOWN_ALLOWED_TAGS}
    />
  );
}

/**
 * Serialize a message's content parts into clipboard text. Built from the
 * message DATA (not the rendered DOM) so it captures each tool call's full
 * request + response even while the card is collapsed — handy for pasting a
 * tool exchange into a bug report.
 *
 * @param parts
 */
function messageToCopyText(parts) {
  return (parts || [])
    .map((p) => {
      if (p.type === "text") {
        return p.text || "";
      }
      if (p.type === "tool-call") {
        const lines = [`Tool: ${p.toolName || "unknown"}`];
        const args = p.args || {};
        if (Object.keys(args).length > 0) {
          lines.push(`Request:\n${JSON.stringify(args, null, 2)}`);
        }
        if (p.result !== undefined) {
          const result =
            typeof p.result === "string"
              ? p.result
              : JSON.stringify(p.result, null, 2);
          lines.push(`Response:\n${result}`);
        }
        return lines.join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Copy text to the clipboard, resolving true on success. Falls back to a
 * hidden textarea + execCommand when the async Clipboard API is unavailable
 * or rejects (e.g. headless CI, where the document isn't focused) so the
 * "Copied!" confirmation stays reliable.
 *
 * Exported because the modal's "Copy transcript" button reuses it.
 *
 * @param {string} text Text to copy.
 * @return {Promise<boolean>} Whether the copy succeeded.
 */
export function copyToClipboard(text) {
  // execCommand first: it's synchronous, so it stays inside the click's
  // user-gesture window. The async Clipboard API loses that gesture after its
  // first await, so using it as the *fallback* (after a rejection) no-ops in
  // headless CI. Deprecated but still works everywhere, including headless.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) {
      return Promise.resolve(true);
    }
  } catch {
    // fall through to the async API
  }
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  return Promise.resolve(false);
}

function CopyMessageButton() {
  const [copied, setCopied] = useState(false);
  const content = useMessage((s) => s.content);

  const handleCopy = useCallback(() => {
    const text = messageToCopyText(content);
    copyToClipboard(text).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  return (
    <button
      type="button"
      className="gds-assistant__copy-btn"
      onClick={handleCopy}
      title="Copy message"
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}
