import {
  AssistantModalPrimitive,
  ThreadPrimitive,
  useThreadRuntime,
} from "@assistant-ui/react";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "@wordpress/element";
import { fetchConversations } from "../hooks/use-runtime-adapter";
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
import { UndoContext } from "./UndoContext";

/**
 * Floating assistant modal for the WP admin.
 * Uses assistant-ui primitives for full control over rendering.
 *
 * @param {Object}   root0                       Component props.
 * @param {Function} root0.onNewChat             Callback to start a new chat.
 * @param {Function} root0.onLoadConversation    Callback to load an old conversation by UUID.
 * @param {string}   root0.systemContext         Optional system context prepended to first message.
 * @param {Function} root0.onSystemContextChange Callback when system context changes.
 * @param {Function} root0.onApproveToolCall     Callback to approve pending tool calls.
 * @param {Function} root0.onDenyToolCall        Callback to deny pending tool calls.
 * @param {Array}    root0.pendingApprovals      Array of pending approval items {toolUseId, toolName, input}.
 */
/**
 * Read persisted panel size from localStorage, guarding against stale or
 * out-of-bounds values (user resized their window smaller, changed monitors,
 * etc.). Falls back to null → CSS defaults apply.
 */
function getStoredPanelSize() {
  try {
    const raw = localStorage.getItem("gds-assistant-panel-size");
    if (!raw) return null;
    const { width, height } = JSON.parse(raw);
    const maxW = window.innerWidth - 48;
    const maxH = window.innerHeight - 120;
    if (typeof width !== "number" || typeof height !== "number") return null;
    return {
      width: Math.max(320, Math.min(maxW, width)),
      height: Math.max(400, Math.min(maxH, height)),
    };
  } catch {
    return null;
  }
}

/**
 * Override Radix/floating-ui's inline transform positioning.
 *
 * Radix uses `Object.assign(node.style, {transform: '...', left: '...'})`
 * to position its Content on every autoUpdate tick. `Object.assign`
 * wipes any !important flags we set via setProperty — so a plain
 * `setProperty('transform', 'none', 'important')` doesn't stick.
 *
 * The reliable win is CSS `!important` in a stylesheet (which beats a
 * plain inline style from Radix) combined with CSS custom properties
 * for the values (CSS vars survive on the element because they're set
 * via React's style= prop, which React DOES preserve across renders).
 * @param node
 * @param top
 * @param left
 */
function applyPanelPosition(node, top, left) {
  if (!node) return;
  node.style.setProperty("--gds-panel-top", `${top}px`);
  node.style.setProperty("--gds-panel-left", `${left}px`);
  // Radix wraps Content in <div data-radix-popper-content-wrapper> that
  // itself has transform. When a parent has transform, our position:fixed
  // on the panel becomes relative to the wrapper, not the viewport — so
  // we tag the wrapper too. CSS rule for this class flattens the wrapper.
  const wrapper = node.closest("[data-radix-popper-content-wrapper]");
  if (wrapper) wrapper.classList.add("gds-assistant__panel-wrapper--moved");
}

function clearPanelPosition(node) {
  if (!node) return;
  node.style.removeProperty("--gds-panel-top");
  node.style.removeProperty("--gds-panel-left");
  const wrapper = node.closest("[data-radix-popper-content-wrapper]");
  if (wrapper) wrapper.classList.remove("gds-assistant__panel-wrapper--moved");
}

/**
 * Read persisted panel position (top/left in px). Returns null to keep
 * the CSS default (bottom-right anchored). Clamps to keep the panel
 * on-screen after window resizes / monitor changes.
 */
function getStoredPanelPosition() {
  try {
    const raw = localStorage.getItem("gds-assistant-panel-position");
    if (!raw) return null;
    const { top, left } = JSON.parse(raw);
    if (typeof top !== "number" || typeof left !== "number") return null;
    // Keep at least 40px of the panel on-screen at all edges so the user
    // can always grab the drag handle.
    return {
      top: Math.max(0, Math.min(window.innerHeight - 40, top)),
      left: Math.max(0, Math.min(window.innerWidth - 40, left)),
    };
  } catch {
    return null;
  }
}

export function AssistantModal({
  onNewChat,
  onLoadConversation,
  systemContext,
  onSystemContextChange,
  onApproveToolCall,
  onDenyToolCall,
  pendingApprovals,
  undoableActions,
  onUndo,
}) {
  const undoContextValue = useMemo(
    () => ({
      undoableActions: undoableActions || {},
      onUndo,
      // Tool-call cards detect their "approval required" state by id — assistant-ui
      // doesn't surface requires-action status for external-store parts.
      pendingApprovalIds: new Set(
        (pendingApprovals || []).map((p) => p.toolUseId),
      ),
    }),
    [undoableActions, onUndo, pendingApprovals],
  );

  // Persist open/closed state so the panel reopens itself after a full-page
  // wp-admin navigation. Root is uncontrolled (Cmd+K and resume click the
  // trigger), so defaultOpen seeds the initial state on mount and onOpenChange
  // records every subsequent toggle.
  const initialOpen = useMemo(() => {
    try {
      return localStorage.getItem("gds-assistant-open") === "1";
    } catch {
      return false;
    }
  }, []);
  const handleOpenChange = useCallback((open) => {
    try {
      localStorage.setItem("gds-assistant-open", open ? "1" : "0");
    } catch {
      // Ignore storage failures (private mode, quota).
    }
  }, []);

  // Keyboard shortcut: Cmd+K / Ctrl+K to toggle modal
  // Also open when a conversation is resumed
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  // Track moved state in React so the --moved class is part of the
  // className prop — React strips DOM classes that aren't in the prop
  // on re-render, which was wiping our override class mid-drag.
  const [isMoved, setIsMoved] = useState(() => !!getStoredPanelPosition());

  const panelClassName = useMemo(
    () =>
      `gds-assistant gds-assistant__panel${
        isMoved ? " gds-assistant__panel--moved" : ""
      }`,
    [isMoved],
  );

  // Callback ref: fires every time the panel element mounts (the modal
  // uses a portal + may unmount on close, so a plain useEffect only runs
  // once). Applies the stored size + position whenever a new panel node
  // appears.
  const setPanelRef = useCallback((node) => {
    panelRef.current = node;
    if (!node) return;
    const size = getStoredPanelSize();
    if (size) {
      node.style.width = `${size.width}px`;
      node.style.height = `${size.height}px`;
    }
    const pos = getStoredPanelPosition();
    if (pos) {
      // applyPanelPosition sets CSS vars AND tags the wrapper — critical
      // because without the wrapper tag its transform forwards the
      // position: fixed panel off-screen on page reload.
      applyPanelPosition(node, pos.top, pos.left);
    }
  }, []);

  // Drag the panel around by its header. Starts a drag only on empty
  // header space — clicks on buttons inside the header still work
  // normally because they stop propagation naturally.
  const onHeaderMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest("button, input, textarea, select, a")) return;

    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;

    // Snapshot initial rect + mouse pos, THEN lock our positioning
    // immediately so the panel stays put during the drag (no jump).
    const rect = panel.getBoundingClientRect();
    const startTop = rect.top;
    const startLeft = rect.left;
    const startX = e.clientX;
    const startY = e.clientY;

    // Pin the panel at its current visual location. Flip React state so
    // the --moved class is rendered via the className prop (React would
    // strip a DOM-only class on next render).
    setIsMoved(true);
    applyPanelPosition(panel, startTop, startLeft);

    const clamp = (top, left) => ({
      top: Math.max(0, Math.min(window.innerHeight - 40, top)),
      left: Math.max(0, Math.min(window.innerWidth - 40, left)),
    });

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const { top, left } = clamp(startTop + dy, startLeft + dx);
      applyPanelPosition(panel, top, left);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem(
          "gds-assistant-panel-position",
          JSON.stringify({ top: r.top, left: r.left }),
        );
      } catch {
        // noop
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Reset position/size to defaults (clears both localStorage keys and
  // inline styles). Exposed via a button in the header context menu or
  // can be called from console.
  const resetPanelPosition = useCallback(() => {
    try {
      localStorage.removeItem("gds-assistant-panel-position");
      localStorage.removeItem("gds-assistant-panel-size");
    } catch {
      // noop
    }
    setIsMoved(false);
    const panel = panelRef.current;
    if (panel) {
      clearPanelPosition(panel);
      panel.style.width = "";
      panel.style.height = "";
    }
  }, []);

  // Resize handle drag logic. The handle sits in the TOP-LEFT corner of
  // the panel since the panel is anchored bottom-right — dragging up/left
  // grows outward in both dimensions naturally.
  const onResizeStart = useCallback((e) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;

    const onMove = (ev) => {
      // Anchored bottom-right, so dragging LEFT increases width and
      // dragging UP increases height.
      const dx = startX - ev.clientX;
      const dy = startY - ev.clientY;
      const maxW = window.innerWidth - 48;
      const maxH = window.innerHeight - 120;
      const w = Math.max(320, Math.min(maxW, startW + dx));
      const h = Math.max(400, Math.min(maxH, startH + dy));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(
          "gds-assistant-panel-size",
          JSON.stringify({
            width: panel.offsetWidth,
            height: panel.offsetHeight,
          }),
        );
      } catch {
        // Private browsing etc. — non-fatal.
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        triggerRef.current?.click();
      }
    };
    // Open modal when resume event fires
    const resumeHandler = () => {
      // Small delay to let loadConversation complete first
      setTimeout(() => triggerRef.current?.click(), 100);
    };
    window.addEventListener("gds-assistant-resume", resumeHandler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      window.removeEventListener("gds-assistant-resume", resumeHandler);
    };
  }, []);

  return (
    <AssistantModalPrimitive.Root
      defaultOpen={initialOpen}
      onOpenChange={handleOpenChange}
    >
      <AssistantModalPrimitive.Trigger
        ref={triggerRef}
        className="gds-assistant gds-assistant__trigger"
      >
        <span className="gds-assistant__trigger-icon">✦</span>
      </AssistantModalPrimitive.Trigger>

      <AssistantModalPrimitive.Content
        ref={setPanelRef}
        className={panelClassName}
        sideOffset={16}
      >
        <div
          className="gds-assistant__resize-handle"
          onMouseDown={onResizeStart}
          title="Drag to resize"
          aria-label="Resize chat panel"
        />
        <UndoContext.Provider value={undoContextValue}>
          <Thread
            onNewChat={onNewChat}
            onLoadConversation={onLoadConversation}
            systemContext={systemContext}
            onSystemContextChange={onSystemContextChange}
            onApproveToolCall={onApproveToolCall}
            onDenyToolCall={onDenyToolCall}
            pendingApprovals={pendingApprovals}
            onHeaderMouseDown={onHeaderMouseDown}
            resetPanelPosition={resetPanelPosition}
            onClose={() => triggerRef.current?.click()}
          />
        </UndoContext.Provider>
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
}

/**
 * Render the whole conversation as Markdown (shared by Export-to-file and
 * Copy-to-clipboard). Returns '' for an empty thread.
 * @param msgs
 */
function transcriptToMarkdown(msgs) {
  if (!msgs?.length) return "";

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

function Thread({
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
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [activeTitle, setActiveTitle] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef(null);

  // Close the "⋯" overflow menu on an outside click.
  useEffect(() => {
    if (!showMore) return undefined;
    const onDocClick = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) {
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
    (conv) => {
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
    const md = transcriptToMarkdown(threadRuntime.getState()?.messages || []);
    if (!md) return;
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
    const md = transcriptToMarkdown(threadRuntime.getState()?.messages || []);
    if (!md) return;
    copyToClipboard(md).then((ok) => {
      if (!ok) return;
      setChatCopied(true);
      setTimeout(() => setChatCopied(false), 1500);
    });
  }, [threadRuntime]);

  return (
    <ThreadPrimitive.Root
      className="gds-assistant__thread"
      ref={(el) => {
        // Auto-focus composer input when thread mounts
        if (el) {
          setTimeout(() => {
            el.querySelector(".gds-assistant__input")?.focus();
          }, 100);
        }
      }}
    >
      <div
        className="gds-assistant__header"
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={(e) => {
          // Double-click empty header area to reset panel position/size
          if (e.target.closest("button, input, textarea, select, a")) return;
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
