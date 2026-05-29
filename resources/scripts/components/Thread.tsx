/**
 * Thread — the main chat panel content: header (title + actions + overflow
 * menu), the slide-in side panels (skills / history / system context), the
 * message viewport, the approval bar (when a tool call is pending), the
 * composer, and the footer (model / max-tokens selectors + usage bar).
 *
 * Owns its own state for which side panel is open, the cached conversation
 * list for the history panel, the active conversation title, and the
 * "Copied!" pulse on Copy-chat. Drag and panel-position are still owned by
 * AssistantModal (passed in via `onHeaderMouseDown` and `resetPanelPosition`)
 * because they manipulate the Radix Content node.
 */

import { ThreadPrimitive, useThreadRuntime } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "@wordpress/element";

import {
  fetchConversations,
  type ConversationSummary,
} from "../hooks/use-runtime-adapter";
import type { PendingApproval } from "./assistant-modal";
import { Composer } from "./Composer";
import { AssistantMessage, UserMessage, copyToClipboard } from "./Messages";
import {
  ConversationList,
  EmptyState,
  MaxTokensSelector,
  ModelSelector,
  SkillsList,
  SystemContextInput,
  TypingIndicator,
  UsageBar,
} from "./SidePanels";

/**
 * Minimal shape needed to walk message content for Markdown export — accepts
 * the union of part shapes assistant-ui surfaces, all of which we treat as
 * optional. Matches UiContentPart but kept loose to absorb runtime drift.
 */
interface TranscriptPart {
  type: string;
  text?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

interface TranscriptMessage {
  role: string;
  content?: TranscriptPart[];
}

/**
 * Serialise the thread to Markdown for Export-as-Markdown and Copy-chat.
 * Built from message DATA (not the rendered DOM) so collapsed tool-call cards
 * still emit their full request + response.
 * @param msgs
 */
function transcriptToMarkdown(msgs: TranscriptMessage[] | undefined): string {
  if (!msgs?.length) {
    return "";
  }

  const lines = [
    `# Conversation Export\n`,
    `_Exported: ${new Date().toLocaleString()}_\n`,
    `---\n`,
  ];

  for (const msg of msgs) {
    lines.push(`\n${msg.role === "user" ? "## User" : "## Assistant"}\n`);

    for (const part of msg.content || []) {
      if (part.type === "text") {
        lines.push(part.text || "");
      } else if (part.type === "image") {
        lines.push("\n[Image attached]\n");
      } else if (part.type === "tool-call") {
        lines.push(`\n**Tool:** \`${part.toolName}\``);
        if (part.args && Object.keys(part.args).length > 0) {
          lines.push(
            `\n\`\`\`json\n${JSON.stringify(part.args, null, 2)}\n\`\`\``,
          );
        }
        if (part.result !== undefined) {
          const status = part.isError ? "Error" : "Result";
          const body =
            typeof part.result === "string"
              ? part.result
              : JSON.stringify(part.result);
          lines.push(`\n_${status}:_ ${body}`);
        }
        lines.push("\n");
      }
    }
    lines.push("\n\n---\n");
  }

  return lines.join("");
}

export interface ThreadProps {
  onNewChat: () => void;
  onLoadConversation: (uuid: string) => void;
  systemContext?: string;
  onSystemContextChange: (ctx: string) => void;
  onApproveToolCall: (opts?: { trustHost?: boolean }) => void;
  onDenyToolCall: () => void;
  pendingApprovals: PendingApproval[];
  onHeaderMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  resetPanelPosition?: () => void;
  onClose: () => void;
}

export function Thread({
  onNewChat,
  onLoadConversation,
  systemContext,
  onSystemContextChange,
  onApproveToolCall,
  onDenyToolCall,
  pendingApprovals,
  onHeaderMouseDown,
  resetPanelPosition,
  onClose,
}: ThreadProps): JSX.Element {
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeTitle, setActiveTitle] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  // Close the "⋯" overflow menu on an outside click.
  useEffect(() => {
    if (!showMore) {
      return undefined;
    }
    const onDocClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showMore]);

  const toggleHistory = useCallback(async () => {
    if (!showHistory) {
      const list = await fetchConversations();
      setConversations(list);
    }
    setShowHistory((v) => !v);
    // Panels are mutually exclusive — only one open at a time.
    setShowSkills(false);
    setShowContext(false);
  }, [showHistory]);

  const toggleSkills = useCallback(() => {
    setShowSkills((v) => !v);
    setShowHistory(false);
    setShowContext(false);
  }, []);

  const toggleContext = useCallback(() => {
    setShowContext((v) => !v);
    setShowSkills(false);
    setShowHistory(false);
  }, []);

  const handleSelect = useCallback(
    (conv: ConversationSummary) => {
      onLoadConversation(conv.uuid);
      setActiveTitle(conv.title || "Untitled");
      setShowHistory(false);
    },
    [onLoadConversation],
  );

  const handleNewChat = useCallback(() => {
    setActiveTitle("");
    onNewChat();
  }, [onNewChat]);

  // Export conversation as Markdown
  const threadRuntime = useThreadRuntime();
  const handleExport = useCallback(() => {
    // Thread runtime's `messages` is its own internal union; treat as our
    // minimal TranscriptMessage shape for serialisation — we only read
    // role/content fields the runtime is guaranteed to surface.
    // Runtime's `messages` is a readonly union of its own ThreadMessage
    // shape; cast via unknown to the minimal fields we actually walk.
    const msgs = threadRuntime.getState()?.messages as unknown as
      | TranscriptMessage[]
      | undefined;
    const md = transcriptToMarkdown(msgs || []);
    if (!md) {
      return;
    }
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conversation-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [threadRuntime]);

  const [chatCopied, setChatCopied] = useState(false);
  const handleCopyChat = useCallback(() => {
    // Runtime's `messages` is a readonly union of its own ThreadMessage
    // shape; cast via unknown to the minimal fields we actually walk.
    const msgs = threadRuntime.getState()?.messages as unknown as
      | TranscriptMessage[]
      | undefined;
    const md = transcriptToMarkdown(msgs || []);
    if (!md) {
      return;
    }
    copyToClipboard(md).then((ok) => {
      if (!ok) {
        return;
      }
      setChatCopied(true);
      setTimeout(() => setChatCopied(false), 1500);
    });
  }, [threadRuntime]);

  return (
    <ThreadPrimitive.Root
      className="gds-assistant__thread"
      ref={(el: HTMLDivElement | null) => {
        // Auto-focus composer input when thread mounts
        if (el) {
          setTimeout(() => {
            el.querySelector<HTMLElement>(".gds-assistant__input")?.focus();
          }, 100);
        }
      }}
    >
      {/* Drag-and-double-click are mouse-only affordances on a pure layout
          element — the panel is also keyboard-resizable via the dedicated
          buttons in the header actions, so the static-interaction warning
          doesn't apply in the way the lint rule assumes. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="gds-assistant__header"
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={(e: React.MouseEvent<HTMLDivElement>) => {
          // Double-click empty header area to reset panel position/size
          if (
            (e.target as HTMLElement).closest(
              "button, input, textarea, select, a",
            )
          ) {
            return;
          }
          resetPanelPosition?.();
        }}
        title="Drag to move — double-click to reset"
      >
        <span className="gds-assistant__title">
          {activeTitle || "AI Assistant"}
        </span>
        <div className="gds-assistant__header-actions">
          <button
            type="button"
            className={`gds-assistant__header-btn ${
              showSkills ? "gds-assistant__header-btn--active" : ""
            }`}
            onClick={toggleSkills}
            title="Skills"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span className="gds-assistant__header-btn-label">Skills</span>
          </button>
          <button
            type="button"
            className="gds-assistant__header-btn"
            onClick={handleNewChat}
            title="New chat"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="gds-assistant__header-btn-label">New</span>
          </button>
          <div className="gds-assistant__more" ref={moreRef}>
            <button
              type="button"
              className={`gds-assistant__header-btn ${
                showMore ? "gds-assistant__header-btn--active" : ""
              }`}
              onClick={() => setShowMore((v) => !v)}
              title="More"
              aria-haspopup="menu"
              aria-expanded={showMore}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
              >
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            {showMore && (
              <div className="gds-assistant__more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="gds-assistant__more-item"
                  title="Chat history"
                  onClick={() => {
                    toggleHistory();
                    setShowMore(false);
                  }}
                >
                  Chat history
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="gds-assistant__more-item"
                  onClick={() => {
                    toggleContext();
                    setShowMore(false);
                  }}
                >
                  {showContext ? "Hide system context" : "Edit system context"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="gds-assistant__more-item"
                  title="Export as Markdown"
                  onClick={() => {
                    handleExport();
                    setShowMore(false);
                  }}
                >
                  Export as Markdown
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="gds-assistant__more-item"
                  title="Copy chat to clipboard"
                  onClick={handleCopyChat}
                >
                  {chatCopied ? "Copied!" : "Copy chat to clipboard"}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="gds-assistant__header-btn gds-assistant__header-btn--close"
            onClick={onClose}
            title="Close chat"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {showContext && (
        <SystemContextInput
          value={systemContext}
          onChange={onSystemContextChange}
          onClose={() => setShowContext(false)}
        />
      )}

      {showSkills && (
        <SkillsList
          onUsed={() => setShowSkills(false)}
          onClose={() => setShowSkills(false)}
        />
      )}

      {showHistory && (
        <ConversationList
          conversations={conversations}
          onSelect={handleSelect}
          onClose={() => setShowHistory(false)}
        />
      )}

      <ThreadPrimitive.Viewport className="gds-assistant__viewport">
        <ThreadPrimitive.Empty>
          <EmptyState />
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
        <TypingIndicator />
      </ThreadPrimitive.Viewport>

      {pendingApprovals && pendingApprovals.length > 0 && (
        <div className="gds-assistant__approval-bar">
          <span>
            {pendingApprovals.length === 1
              ? "Approve this action?"
              : `${pendingApprovals.length} pending actions — approve all?`}
          </span>
          <button
            className="gds-assistant__approval-btn gds-assistant__approval-btn--approve"
            onClick={() => onApproveToolCall()}
          >
            {pendingApprovals.length > 1
              ? `Approve (${pendingApprovals.length})`
              : "Approve"}
          </button>
          {pendingApprovals[0]?.trustableHost && (
            <button
              className="gds-assistant__approval-btn gds-assistant__approval-btn--trust"
              onClick={() => onApproveToolCall({ trustHost: true })}
              title={`Approve and never ask again for ${pendingApprovals[0].trustableHost}`}
            >
              Approve & trust {pendingApprovals[0].trustableHost}
            </button>
          )}
          <button
            className="gds-assistant__approval-btn gds-assistant__approval-btn--deny"
            onClick={onDenyToolCall}
          >
            Deny
          </button>
        </div>
      )}

      <Composer />
      <div className="gds-assistant__footer">
        <div className="gds-assistant__footer-controls">
          <ModelSelector />
          <span className="gds-assistant__footer-sep">/</span>
          <MaxTokensSelector />
        </div>
        <UsageBar />
      </div>

      <ThreadPrimitive.ScrollToBottom className="gds-assistant__scroll-btn">
        ↓
      </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  );
}
