import {
  AssistantModalPrimitive,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  AttachmentPrimitive,
  useThreadRuntime,
  useComposerRuntime,
  useMessage,
} from '@assistant-ui/react';
import {useVoiceInput} from '../hooks/use-voice-input';
import {useEditorSelection} from '../hooks/use-editor-selection';
import {
  useTtsEnabled,
  useVoiceMode,
  ttsSupported,
  speakAppend,
  cancelTts,
  extractAssistantText,
  readVoiceLang,
  TTS_EVENTS,
} from '../hooks/use-tts';
import {
  subscribeApprovals,
  getApproval,
  resolveApproval,
  clearAllApprovals,
  confirmEditsEnabled,
  setConfirmEdits,
  CONFIRM_PREF_EVENT,
} from '../editor/approval-queue';
import {StreamdownTextPrimitive} from '@assistant-ui/react-streamdown';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  createContext,
  useContext,
} from '@wordpress/element';
import {
  onUsageUpdate,
  onRunStatus,
  setModel,
  getModel,
  setMaxTokens,
  getMaxTokens,
  fetchConversations,
  formatMessageTime,
} from '../hooks/use-runtime-adapter';

// ── Skills ───────────────────────────────────────────────────
// Cache skills but refresh from REST API periodically
let skillsCache = window.gdsAssistant?.skills || [];
let skillsFetchedAt = 0;

async function getSkillsFresh() {
  const now = Date.now();
  // Refresh every 30s or on first call
  if (now - skillsFetchedAt < 30000 && skillsCache.length > 0) {
    return skillsCache;
  }
  try {
    const {restBase, nonce} = window.gdsAssistant || {};
    const response = await fetch(
      `${restBase}assistant-skills?per_page=100&status=publish&context=edit`,
      {headers: {'X-WP-Nonce': nonce}},
    );
    if (response.ok) {
      const posts = await response.json();
      skillsCache = posts.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title?.rendered || p.title,
        description: p.excerpt?.rendered?.replace(/<[^>]*>/g, '').trim() || '',
        // Use raw content (preserves markdown/formatting) when available
        prompt:
          p.content?.raw ||
          p.content?.rendered?.replace(/<[^>]*>/g, '').trim() ||
          '',
      }));
      skillsFetchedAt = now;
    }
  } catch {
    // Use cached data
  }
  return skillsCache;
}

function getSkills() {
  return skillsCache;
}

// ── Cost thresholds ──────────────────────────────────────────
const COST_WARNING_THRESHOLD = 0.5; // USD

// ── Prompt suggestions for empty state ──────────────────────
const SUGGESTIONS = [
  'List all draft pages',
  'Audit missing translations',
  'Show recent form submissions',
  'How many products are published?',
];

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
    const raw = localStorage.getItem('gds-assistant-panel-size');
    if (!raw) return null;
    const {width, height} = JSON.parse(raw);
    const maxW = window.innerWidth - 48;
    const maxH = window.innerHeight - 120;
    if (typeof width !== 'number' || typeof height !== 'number') return null;
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
  node.style.setProperty('--gds-panel-top', `${top}px`);
  node.style.setProperty('--gds-panel-left', `${left}px`);
  // Radix wraps Content in <div data-radix-popper-content-wrapper> that
  // itself has transform. When a parent has transform, our position:fixed
  // on the panel becomes relative to the wrapper, not the viewport — so
  // we tag the wrapper too. CSS rule for this class flattens the wrapper.
  const wrapper = node.closest('[data-radix-popper-content-wrapper]');
  if (wrapper) wrapper.classList.add('gds-assistant__panel-wrapper--moved');
}

function clearPanelPosition(node) {
  if (!node) return;
  node.style.removeProperty('--gds-panel-top');
  node.style.removeProperty('--gds-panel-left');
  const wrapper = node.closest('[data-radix-popper-content-wrapper]');
  if (wrapper) wrapper.classList.remove('gds-assistant__panel-wrapper--moved');
}

/**
 * Read persisted panel position (top/left in px). Returns null to keep
 * the CSS default (bottom-right anchored). Clamps to keep the panel
 * on-screen after window resizes / monitor changes.
 */
function getStoredPanelPosition() {
  try {
    const raw = localStorage.getItem('gds-assistant-panel-position');
    if (!raw) return null;
    const {top, left} = JSON.parse(raw);
    if (typeof top !== 'number' || typeof left !== 'number') return null;
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

// Carries per-tool undo state ({toolCallId -> {auditId,label,undone,...}}) and
// the undo trigger down to ToolCallFallback, which assistant-ui instantiates
// deep in the tree (so props can't reach it directly).
const UndoContext = createContext({
  undoableActions: {},
  onUndo: null,
  pendingApprovalIds: new Set(),
});

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
      return localStorage.getItem('gds-assistant-open') === '1';
    } catch {
      return false;
    }
  }, []);
  const handleOpenChange = useCallback((open) => {
    try {
      localStorage.setItem('gds-assistant-open', open ? '1' : '0');
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
        isMoved ? ' gds-assistant__panel--moved' : ''
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
    if (target.closest('button, input, textarea, select, a')) return;

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
      const {top, left} = clamp(startTop + dy, startLeft + dx);
      applyPanelPosition(panel, top, left);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem(
          'gds-assistant-panel-position',
          JSON.stringify({top: r.top, left: r.left}),
        );
      } catch {
        // noop
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Reset position/size to defaults (clears both localStorage keys and
  // inline styles). Exposed via a button in the header context menu or
  // can be called from console.
  const resetPanelPosition = useCallback(() => {
    try {
      localStorage.removeItem('gds-assistant-panel-position');
      localStorage.removeItem('gds-assistant-panel-size');
    } catch {
      // noop
    }
    setIsMoved(false);
    const panel = panelRef.current;
    if (panel) {
      clearPanelPosition(panel);
      panel.style.width = '';
      panel.style.height = '';
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
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(
          'gds-assistant-panel-size',
          JSON.stringify({
            width: panel.offsetWidth,
            height: panel.offsetHeight,
          }),
        );
      } catch {
        // Private browsing etc. — non-fatal.
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        triggerRef.current?.click();
      }
    };
    // Open modal when resume event fires
    const resumeHandler = () => {
      // Small delay to let loadConversation complete first
      setTimeout(() => triggerRef.current?.click(), 100);
    };
    window.addEventListener('gds-assistant-resume', resumeHandler);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      window.removeEventListener('gds-assistant-resume', resumeHandler);
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
  if (!msgs?.length) return '';

  const lines = [
    `# Conversation Export\n`,
    `_Exported: ${new Date().toLocaleString()}_\n`,
    `---\n`,
  ];

  for (const msg of msgs) {
    lines.push(`\n${msg.role === 'user' ? '## User' : '## Assistant'}\n`);

    for (const part of msg.content || []) {
      if (part.type === 'text') {
        lines.push(part.text || '');
      } else if (part.type === 'image') {
        lines.push('\n[Image attached]\n');
      } else if (part.type === 'tool-call') {
        lines.push(`\n**Tool:** \`${part.toolName}\``);
        if (part.args && Object.keys(part.args).length > 0) {
          lines.push(
            `\n\`\`\`json\n${JSON.stringify(part.args, null, 2)}\n\`\`\``,
          );
        }
        if (part.result !== undefined) {
          const status = part.isError ? 'Error' : 'Result';
          const body =
            typeof part.result === 'string' ?
              part.result
            : JSON.stringify(part.result);
          lines.push(`\n_${status}:_ ${body}`);
        }
        lines.push('\n');
      }
    }
    lines.push('\n\n---\n');
  }

  return lines.join('');
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
  const [activeTitle, setActiveTitle] = useState('');
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
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
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
      setActiveTitle(conv.title || 'Untitled');
      setShowHistory(false);
    },
    [onLoadConversation],
  );

  const handleNewChat = useCallback(() => {
    setActiveTitle('');
    onNewChat();
  }, [onNewChat]);

  // Export conversation as Markdown
  const threadRuntime = useThreadRuntime();
  const handleExport = useCallback(() => {
    const md = transcriptToMarkdown(threadRuntime.getState()?.messages || []);
    if (!md) return;
    const blob = new Blob([md], {type: 'text/markdown'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
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
            el.querySelector('.gds-assistant__input')?.focus();
          }, 100);
        }
      }}
    >
      <div
        className="gds-assistant__header"
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={(e) => {
          // Double-click empty header area to reset panel position/size
          if (e.target.closest('button, input, textarea, select, a')) return;
          resetPanelPosition?.();
        }}
        title="Drag to move — double-click to reset"
      >
        <span className="gds-assistant__title">
          {activeTitle || 'AI Assistant'}
        </span>
        <div className="gds-assistant__header-actions">
          <button
            type="button"
            className={`gds-assistant__header-btn ${showSkills ? 'gds-assistant__header-btn--active' : ''}`}
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
              className={`gds-assistant__header-btn ${showMore ? 'gds-assistant__header-btn--active' : ''}`}
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
                  {showContext ? 'Hide system context' : 'Edit system context'}
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
                  {chatCopied ? 'Copied!' : 'Copy chat to clipboard'}
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
            {pendingApprovals.length === 1 ?
              'Approve this action?'
            : `${pendingApprovals.length} pending actions — approve all?`}
          </span>
          <button
            className="gds-assistant__approval-btn gds-assistant__approval-btn--approve"
            onClick={() => onApproveToolCall()}
          >
            {pendingApprovals.length > 1 ?
              `Approve (${pendingApprovals.length})`
            : 'Approve'}
          </button>
          {pendingApprovals[0]?.trustableHost && (
            <button
              className="gds-assistant__approval-btn gds-assistant__approval-btn--trust"
              onClick={() => onApproveToolCall({trustHost: true})}
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

// ── Empty state with prompt suggestions ─────────────────────

function EmptyState() {
  const threadRuntime = useThreadRuntime();

  const handleSuggestion = useCallback(
    (text) => {
      threadRuntime.append({
        role: 'user',
        content: [{type: 'text', text}],
      });
    },
    [threadRuntime],
  );

  return (
    <div className="gds-assistant__empty">
      <div>
        <p className="gds-assistant__empty-title">
          How can I help you manage your site?
        </p>
        <div className="gds-assistant__suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="gds-assistant__suggestion"
              onClick={() => handleSuggestion(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── System context input ────────────────────────────────────

// Small header for the slide-in panels (skills, history, system context) so
// each one carries its own title and an unambiguous close (×) — the panels are
// opened from the "⋯" menu, so without this there's no visible way to dismiss
// them.
function PanelHeader({title, onClose}) {
  return (
    <div className="gds-assistant__panel-head">
      <span className="gds-assistant__panel-head-title">{title}</span>
      <button
        type="button"
        className="gds-assistant__panel-head-close"
        onClick={onClose}
        title="Collapse"
        aria-label="Collapse"
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
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
    </div>
  );
}

function SystemContextInput({value, onChange, onClose}) {
  return (
    <div className="gds-assistant__context">
      <PanelHeader title="System context" onClose={onClose} />
      <textarea
        className="gds-assistant__context-input"
        placeholder='Add context for this chat, e.g. "You&apos;re helping me restructure the Finnish product pages"'
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
      />
    </div>
  );
}

// ── Cost / usage helpers ────────────────────────────────────

/**
 * Format a dollar amount for display.
 *
 * @param {number} dollars Dollar amount.
 * @return {string} Formatted cost string.
 */
function formatCost(dollars) {
  if (dollars < 0.001) return '<$0.001';
  return `~$${dollars.toFixed(3)}`;
}

/**
 * Format a date as relative time (5m ago, 2h ago, Yesterday, Apr 10).
 *
 * @param {string} dateStr UTC datetime string.
 * @return {string} Formatted relative time.
 */
function relativeTime(dateStr) {
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

// ── Skills list panel ────────────────────────────────────────

function SkillsList({onUsed, onClose}) {
  const [skills, setSkills] = useState(getSkills);
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    getSkillsFresh().then(setSkills);
  }, []);

  const handleUse = useCallback(
    (skill) => {
      // Auto-switch model if skill has a preferred one
      if (skill.model) {
        setModel(skill.model);
      }
      threadRuntime.append({
        role: 'user',
        content: [{type: 'text', text: skill.prompt}],
      });
      onUsed?.();
    },
    [threadRuntime, onUsed],
  );

  if (!skills.length) {
    return (
      <div className="gds-assistant__skills-list">
        <PanelHeader title="Skills" onClose={onClose} />
        <p className="gds-assistant__history-empty">
          No skills yet. Ask the assistant to create one!
        </p>
      </div>
    );
  }

  return (
    <div className="gds-assistant__skills-list">
      <PanelHeader title="Skills" onClose={onClose} />
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          className="gds-assistant__skill-item"
          onClick={() => handleUse(skill)}
          title={skill.prompt}
        >
          <div className="gds-assistant__skill-info">
            <span className="gds-assistant__skill-name">/{skill.slug}</span>
            <span className="gds-assistant__skill-title">{skill.title}</span>
          </div>
          {(skill.description || skill.model) && (
            <span className="gds-assistant__skill-desc">
              {skill.description}
              {skill.model && (
                <span className="gds-assistant__skill-model">
                  {' '}
                  ({skill.model.split(':').pop()})
                </span>
              )}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Typing indicator ────────────────────────────────────────

function TypingIndicator() {
  const threadRuntime = useThreadRuntime();
  const [isRunning, setIsRunning] = useState(false);
  // What's happening right now ("Reading the editor…", "Editing the document…")
  // so a slow turn shows progress instead of three blind dots.
  const [status, setStatus] = useState('');

  useEffect(() => {
    return threadRuntime.subscribe(() => {
      setIsRunning(threadRuntime.getState().isRunning);
    });
  }, [threadRuntime]);

  useEffect(() => onRunStatus(setStatus), []);

  if (!isRunning) return null;

  return (
    <div className="gds-assistant__typing">
      {status ?
        <span className="gds-assistant__typing-status">{status}</span>
      : null}
      <span className="gds-assistant__typing-dot" />
      <span className="gds-assistant__typing-dot" />
      <span className="gds-assistant__typing-dot" />
    </div>
  );
}

// ── Slash command autocomplete ───────────────────────────────

function SlashAutocomplete({query, onSelect, onDismiss}) {
  const [skills, setSkills] = useState(getSkills);

  useEffect(() => {
    getSkillsFresh().then(setSkills);
  }, []);

  const filtered = skills.filter(
    (s) =>
      s.slug.includes(query) ||
      s.title.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onDismiss]);

  if (!filtered.length) return null;

  return (
    <div className="gds-assistant__autocomplete">
      {filtered.slice(0, 6).map((skill) => (
        <button
          key={skill.id}
          type="button"
          className="gds-assistant__autocomplete-item"
          onMouseDown={(e) => {
            e.preventDefault(); // prevent input blur
            onSelect(skill);
          }}
        >
          <span className="gds-assistant__autocomplete-slug">
            /{skill.slug}
          </span>
          <span className="gds-assistant__autocomplete-desc">
            {skill.title}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Conversation history list ───────────────────────────────

function ConversationList({conversations, onSelect, onClose}) {
  const [search, setSearch] = useState('');
  const filtered =
    search ?
      conversations.filter((c) =>
        (c.title || '').toLowerCase().includes(search.toLowerCase()),
      )
    : conversations;

  if (!conversations.length) {
    return (
      <div className="gds-assistant__history-list">
        <PanelHeader title="Chat history" onClose={onClose} />
        <p className="gds-assistant__history-empty">No previous chats</p>
      </div>
    );
  }

  return (
    <div className="gds-assistant__history-list">
      <PanelHeader title="Chat history" onClose={onClose} />
      <input
        type="text"
        className="gds-assistant__history-search"
        placeholder="Search conversations..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {filtered.map((conv) => (
        <button
          key={conv.uuid}
          type="button"
          className="gds-assistant__history-item"
          onClick={() => onSelect(conv)}
        >
          <span className="gds-assistant__history-title">
            {conv.title || 'Untitled'}
          </span>
          <span className="gds-assistant__history-meta">
            {(conv.total_input_tokens > 0 || conv.total_output_tokens > 0) && (
              <span className="gds-assistant__history-cost">
                {formatCost(
                  ((Number(conv.total_input_tokens) || 0) / 1e6) * 3 +
                    ((Number(conv.total_output_tokens) || 0) / 1e6) * 15,
                )}
              </span>
            )}
            {relativeTime(conv.updated_at)}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Model / token selectors ─────────────────────────────────

function getModelConfig() {
  return window.gdsAssistant?.models || {providers: [], default: null};
}

function getDefaultModelKey() {
  return getModelConfig().default || '';
}

function ModelSelector() {
  const [model, setModelState] = useState(
    () => getModel() || getDefaultModelKey(),
  );
  const config = getModelConfig();

  const handleChange = useCallback((e) => {
    const value = e.target.value;
    setModelState(value);
    setModel(value);
  }, []);

  return (
    <select
      className="gds-assistant__model-select"
      value={model}
      onChange={handleChange}
      title="Select model"
    >
      {config.providers.map((provider) => (
        <optgroup key={provider.name} label={provider.label}>
          {provider.models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} {m.tier || ''}
              {m.capabilityTier === 'read' ? ' (read-only)' : ''}
              {m.capabilityTier === 'full' ? ' (full access)' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function getMaxTokensOptions() {
  const def = window.gdsAssistant?.defaultMaxTokens || 4096;
  const presets = [4096, 8192, 16384, 32768];
  const formatK = (v) => `${Math.round(v / 1024)}K`;
  return [
    {value: 0, label: formatK(def)},
    ...presets
      .filter((v) => v !== def)
      .map((v) => ({value: v, label: formatK(v)})),
  ];
}

function MaxTokensSelector() {
  const [tokens, setTokensState] = useState(getMaxTokens);

  const handleChange = useCallback((e) => {
    const value = parseInt(e.target.value, 10);
    setTokensState(value);
    setMaxTokens(value);
  }, []);

  return (
    <select
      className="gds-assistant__model-select"
      value={tokens}
      onChange={handleChange}
      title="Max output tokens"
    >
      {getMaxTokensOptions().map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ── Usage bar with cost warning ─────────────────────────────

function UsageBar() {
  const [usage, setUsage] = useState({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  });

  useEffect(() => onUsageUpdate(setUsage), []);

  if (usage.inputTokens === 0 && usage.outputTokens === 0) return null;

  const total = usage.inputTokens + usage.outputTokens;
  const overBudget = usage.cost >= COST_WARNING_THRESHOLD;

  return (
    <div className="gds-assistant__usage">
      <span
        className={overBudget ? 'gds-assistant__usage--warn' : ''}
        title={`Input: ${usage.inputTokens.toLocaleString()} / Output: ${usage.outputTokens.toLocaleString()} · ${formatCost(usage.cost)}`}
      >
        {total.toLocaleString()} tokens{overBudget ? ' ⚠' : ''}
      </span>
    </div>
  );
}

// ── Voice-to-text mic ───────────────────────────────────────

// Pick the initial dictation language: a remembered choice, else the page
// language (matched against the available codes), else the first available.
function pickInitialVoiceLang(langs) {
  if (!langs.length) return undefined;
  const codes = langs.map((l) => l.code);
  try {
    const saved = localStorage.getItem('gds-assistant-voice-lang');
    if (saved && codes.includes(saved)) return saved;
  } catch {
    // storage unavailable
  }
  const page = (
    document.documentElement.lang ||
    navigator.language ||
    ''
  ).toLowerCase();
  const exact = codes.find((c) => c.toLowerCase() === page);
  if (exact) return exact;
  const primary = page.split('-')[0];
  return (
    codes.find((c) => c.toLowerCase().split('-')[0] === primary) || codes[0]
  );
}

function MicButton() {
  const composer = useComposerRuntime();
  // The text already in the composer when dictation starts — the transcript is
  // appended to it so we never clobber what the user typed.
  const baseRef = useRef('');
  // Web Speech can't auto-detect language; offer the site's languages (from
  // Polylang via the localized config) so a user can dictate in one that
  // differs from the admin UI language.
  const langs = window.gdsAssistant?.voiceLanguages || [];
  const [lang, setLang] = useState(() => pickInitialVoiceLang(langs));
  const [langOpen, setLangOpen] = useState(false);
  const wrapRef = useRef(null);
  const [readAloud, setReadAloud] = useTtsEnabled();
  const [voiceMode, setVoiceMode] = useVoiceMode();
  const [confirmEdits, setConfirmEditsState] = useState(confirmEditsEnabled);
  useEffect(() => {
    const sync = () => setConfirmEditsState(confirmEditsEnabled());
    window.addEventListener('storage', sync);
    window.addEventListener(CONFIRM_PREF_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CONFIRM_PREF_EVENT, sync);
    };
  }, []);
  const ttsAvail = ttsSupported();
  // Silence-based auto-send timer for Voice mode. ref so it isn't recreated
  // every render and so its handlers see the freshest composer/threadRuntime
  // values.
  const silenceTimerRef = useRef(null);
  const voiceModeRef = useRef(voiceMode);
  const hasFinalRef = useRef(false);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
  const {supported, listening, start, stop} = useVoiceInput({
    lang,
    onResult: (transcript, isFinal) => {
      const base = baseRef.current;
      const sep = base && !/\s$/.test(base) ? ' ' : '';
      composer.setText(base + sep + transcript);

      if (isFinal) hasFinalRef.current = true;

      // Voice mode: any result event (interim or final) resets the silence
      // window; if no further events arrive within SEND_AFTER_SILENCE_MS the
      // composer auto-sends. We only arm after we've seen at least one final
      // so the user has to actually say something.
      if (voiceModeRef.current) {
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        silenceTimerRef.current = setTimeout(() => {
          silenceTimerRef.current = null;
          if (!hasFinalRef.current) return;
          const text = composer.getState?.()?.text || '';
          if (!text.trim()) return;
          hasFinalRef.current = false;
          baseRef.current = '';
          composer.send?.();
        }, 1500);
      }
    },
  });

  // Close the language popover on an outside click.
  useEffect(() => {
    if (!langOpen) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setLangOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [langOpen]);

  // Skype-style half-duplex: while the user "wants the mic on" we shuttle it
  // off during the AI's turn (so we don't transcribe its own voice back in)
  // and turn it back on once the AI is done. The user's intent flips only on
  // explicit mic taps — auto pause/resume keeps it consistent across replies.
  const intendsRef = useRef(false);
  const listeningRef = useRef(false);
  const readAloudRef = useRef(readAloud);
  const threadRuntime = useThreadRuntime();
  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);
  useEffect(() => {
    readAloudRef.current = readAloud;
  }, [readAloud]);

  const tryRestart = useCallback(() => {
    if (!intendsRef.current) return;
    if (listeningRef.current) return;
    // Don't restart while TTS is still draining (cancel/end race).
    if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) return;
    baseRef.current = composer.getState?.()?.text || '';
    start();
  }, [start, composer]);

  // TTS start → drop the mic; TTS end → bring it back if the user still wants it.
  useEffect(() => {
    if (!supported) return undefined;
    const onTtsStart = () => {
      if (listeningRef.current) stop();
    };
    const onTtsEnd = () => {
      // Small delay so the cancel-drained queue settles before we re-listen.
      setTimeout(tryRestart, 80);
    };
    window.addEventListener(TTS_EVENTS.start, onTtsStart);
    window.addEventListener(TTS_EVENTS.end, onTtsEnd);
    return () => {
      window.removeEventListener(TTS_EVENTS.start, onTtsStart);
      window.removeEventListener(TTS_EVENTS.end, onTtsEnd);
    };
  }, [supported, stop, tryRestart]);

  // Mute the mic for the assistant's turn (so a user mid-sentence doesn't get
  // recorded talking over the run), and resume on turn-end when read-aloud is
  // OFF (when it's ON, the TTS_END handler above takes care of resuming).
  useEffect(() => {
    if (!supported) return undefined;
    let prevRunning = false;
    return threadRuntime.subscribe(() => {
      const running = !!threadRuntime.getState?.()?.isRunning;
      if (running && !prevRunning && listeningRef.current) {
        stop();
      }
      if (!running && prevRunning && !readAloudRef.current) {
        setTimeout(tryRestart, 80);
      }
      prevRunning = running;
    });
  }, [supported, stop, tryRestart, threadRuntime]);

  if (!supported) return null;

  const handle = () => {
    if (listening) {
      intendsRef.current = false;
      // Explicit stop overrides any pending auto-send timer.
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      stop();
      return;
    }
    intendsRef.current = true;
    hasFinalRef.current = false;
    // User taking a turn — shut the AI up so we don't transcribe its voice.
    cancelTts();
    baseRef.current = composer.getState?.()?.text || '';
    start();
  };

  const choose = (code) => {
    setLang(code);
    setLangOpen(false);
    try {
      localStorage.setItem('gds-assistant-voice-lang', code);
    } catch {
      // storage unavailable
    }
  };

  // Chevron + popover are useful when there's >1 dictation language OR when
  // TTS is supported (so the user can flip the read-aloud toggle); hide the
  // chevron only when neither is true.
  const showPopoverToggle = langs.length > 1 || ttsAvail;

  return (
    <div className="gds-assistant__voice" ref={wrapRef}>
      {/* Popover opens upward (composer is pinned to the panel bottom). */}
      {showPopoverToggle && langOpen && (
        <div className="gds-assistant__voice-langs" role="menu">
          {langs.length > 1 &&
            langs.map((l) => (
              <button
                key={l.code}
                type="button"
                role="menuitemradio"
                aria-checked={l.code === lang}
                className={`gds-assistant__voice-langs-item${l.code === lang ? ' is-active' : ''}`}
                onClick={() => choose(l.code)}
              >
                <span>{l.name}</span>
                {l.code === lang && (
                  <span
                    className="gds-assistant__voice-langs-check"
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                )}
              </button>
            ))}
          {ttsAvail && langs.length > 1 && (
            <div
              className="gds-assistant__voice-langs-sep"
              aria-hidden="true"
            />
          )}
          {ttsAvail && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={readAloud}
              className={`gds-assistant__voice-langs-item gds-assistant__voice-langs-toggle${readAloud ? ' is-active' : ''}`}
              onClick={() => setReadAloud(!readAloud)}
              title="Read assistant replies aloud using Web Speech"
            >
              <span>Read replies aloud</span>
              <span
                className={`gds-assistant__voice-switch${readAloud ? ' is-on' : ''}`}
                aria-hidden="true"
              >
                <span className="gds-assistant__voice-switch-knob" />
              </span>
            </button>
          )}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={voiceMode}
            className={`gds-assistant__voice-langs-item gds-assistant__voice-langs-toggle${voiceMode ? ' is-active' : ''}`}
            onClick={() => setVoiceMode(!voiceMode)}
            title="Auto-send the message after a short pause when dictating"
          >
            <span>Voice mode (auto-send)</span>
            <span
              className={`gds-assistant__voice-switch${voiceMode ? ' is-on' : ''}`}
              aria-hidden="true"
            >
              <span className="gds-assistant__voice-switch-knob" />
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={confirmEdits}
            className={`gds-assistant__voice-langs-item gds-assistant__voice-langs-toggle${confirmEdits ? ' is-active' : ''}`}
            onClick={() => {
              setConfirmEdits(!confirmEdits);
              setConfirmEditsState(!confirmEdits);
            }}
            title="Show a diff card with Apply / Reject before editor changes"
          >
            <span>Confirm edits before applying</span>
            <span
              className={`gds-assistant__voice-switch${confirmEdits ? ' is-on' : ''}`}
              aria-hidden="true"
            >
              <span className="gds-assistant__voice-switch-knob" />
            </span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={`gds-assistant__mic${listening ? ' gds-assistant__mic--listening' : ''}`}
        onClick={handle}
        title={listening ? 'Stop dictation' : 'Dictate (voice to text)'}
        aria-pressed={listening}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
      {showPopoverToggle && (
        <button
          type="button"
          className="gds-assistant__voice-lang"
          onClick={() => setLangOpen((v) => !v)}
          disabled={listening}
          title={
            langs.length > 1
              ? 'Voice settings (dictation language + read aloud)'
              : 'Voice settings'
          }
          aria-haspopup="menu"
          aria-expanded={langOpen}
        >
          <svg
            className="gds-assistant__voice-chevron"
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ── Read-aloud controller ───────────────────────────────────
//
// Side-effect component (renders nothing). Subscribes to the thread runtime
// and, when the toggle is on, reads each completed assistant message aloud
// via the Web Speech API. Speech is cancelled when:
//   - a new run starts (user sent the next message)
//   - the toggle is flipped off
//   - the component unmounts (chat panel closes)

// Auto-reject any pending edit approvals if the chat goes away (e.g. the
// user navigates off the page), AND when a fresh user run starts — typing
// a new message into the composer is itself a signal that the user has
// moved on from any in-flight approval card, and leaving it pending would
// strand a tool_use without a tool_result and silently break the next turn.
function ApprovalCleanup() {
  const threadRuntime = useThreadRuntime();
  useEffect(() => {
    let prevRunning = false;
    const unsub = threadRuntime.subscribe(() => {
      const running = !!threadRuntime.getState?.()?.isRunning;
      if (running && !prevRunning) clearAllApprovals();
      prevRunning = running;
    });
    return () => {
      if (typeof unsub === 'function') unsub();
      clearAllApprovals();
    };
  }, [threadRuntime]);
  return null;
}

function ReadAloudController() {
  const [enabled] = useTtsEnabled();
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!enabled || !ttsSupported()) return undefined;

    let wasRunning = false;
    // Per-message bookkeeping for streaming reads. We track the offset into
    // the message's plain text that we've already queued for speech, so each
    // tick we only enqueue the *new* fully-formed sentences. Map keyed by a
    // stable per-message key so an interim id changing to a final id (which
    // assistant-ui sometimes does on completion) doesn't reset progress.
    const progress = new Map(); // key -> {offset, lastTextLen, finalised}

    const speakUpTo = (key, text, lang, atEnd) => {
      const state = progress.get(key) || {offset: 0, lastTextLen: 0, finalised: false};
      const remainder = text.slice(state.offset);
      if (!remainder.length) {
        progress.set(key, {...state, lastTextLen: text.length});
        return;
      }

      // Mid-stream: only queue *complete* sentences so we don't speak a half
      // word the engine then re-pronounces when the next token arrives. At
      // the end of the run, just speak everything that's left regardless.
      let consume = 0;
      if (atEnd) {
        consume = remainder.length;
      } else {
        // Last sentence-terminator in the remainder. JS regex doesn't expose
        // lastIndexOf for patterns, so iterate.
        const re = /[.!?。！？]["')\]]?(?=\s|$)/g;
        let m;
        let lastEnd = -1;
        while ((m = re.exec(remainder)) !== null) {
          lastEnd = m.index + m[0].length;
        }
        if (lastEnd < 0) return;
        // Don't speak less than a few words; avoids machine-gun queueing
        // when the model emits short fragments token-by-token.
        if (lastEnd < 16) return;
        consume = lastEnd;
      }

      const chunk = remainder.slice(0, consume).trim();
      if (chunk) speakAppend(chunk, lang);
      progress.set(key, {
        offset: state.offset + consume,
        lastTextLen: text.length,
        finalised: atEnd,
      });
    };

    // Has the user actually started a run in *this* mount? Until they do,
    // every assistant message we see is loaded history — never to be
    // narrated. This is the only reliable refresh-safety check: seeding
    // messages on mount doesn't help because the runtime loads them
    // asynchronously *after* the controller has subscribed.
    let armed = false;

    const tick = () => {
      const state = threadRuntime.getState?.();
      if (!state) return;
      const running = !!state.isRunning;
      const messages = state.messages || [];

      // A false → true transition is the user-initiated signal that turns on
      // narration. Until then we silently track state and never speak.
      if (running && !wasRunning) {
        armed = true;
        cancelTts();
      }

      if (!armed) {
        wasRunning = running;
        return;
      }

      // Only narrate when the most recent message in the thread is an
      // assistant message. After a user send the tail is the user's message,
      // so falling back to the *previous* assistant would speak the prior
      // reply. The tail index doubles as the key so an id change between
      // interim and final doesn't reset the spoken offset.
      const tail = messages[messages.length - 1];
      if (tail?.role !== 'assistant') {
        wasRunning = running;
        return;
      }

      const tailIdx = messages.length - 1;
      const key = tail.id || `idx:${tailIdx}`;
      const text = extractAssistantText(tail);
      if (text) speakUpTo(key, text, readVoiceLang(), !running);

      wasRunning = running;
    };

    // Seed `wasRunning` from the current state so a refresh that lands
    // mid-stream doesn't fire a spurious "run just started" cancel on the
    // first tick. (The `armed` gate above takes care of the "don't narrate
    // history" guarantee.)
    wasRunning = !!threadRuntime.getState?.()?.isRunning;

    const unsub = threadRuntime.subscribe(tick);
    return () => {
      if (typeof unsub === 'function') unsub();
      cancelTts();
    };
  }, [enabled, threadRuntime]);

  return null;
}

// ── Editor-selection chip ───────────────────────────────────
//
// Shows above the composer input whenever the user has something selected in
// the editor — a text range, a whole block, or several blocks. Gives a visible
// signal that the next message will go out with that selection already
// attached as context (server-side, prepended to the user's message body), so
// prompts like "make this punchier" or "translate these" work without the
// model needing an `editor__read_selection` round-trip.

// Hard cap on snippet length sent to the chip so we don't ship megabytes into
// the tooltip on huge documents. CSS (-webkit-line-clamp) handles the visual
// truncation; this is just a backstop.
function clampSnippet(text, max = 280) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

const SelectionIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 7V4h16v3" />
    <path d="M9 20h6" />
    <path d="M12 4v16" />
  </svg>
);

function SelectionChip() {
  const selection = useEditorSelection();
  if (!selection) return null;

  let label;
  let snippet;
  let title;

  if (selection.mode === 'multi-block') {
    const labels = selection.blockLabels || [];
    const head = labels.slice(0, 3).join(', ');
    const more = labels.length > 3 ? ` +${labels.length - 3} more` : '';
    label = `Selected ${selection.count} blocks`;
    snippet = labels.length ? `${head}${more}` : '';
    title = `Selected ${selection.count} blocks: ${labels.join(', ')}`;
  } else {
    const text =
      selection.mode === 'text-range'
        ? selection.selectedText
        : selection.blockText;
    label = `Selected ${selection.blockLabel}`;
    snippet = clampSnippet(text);
    title = text
      ? `${label}: ${text}`
      : `${label} (block ${selection.clientId})`;
  }

  return (
    <div className="gds-assistant__selection-chip" title={title}>
      {SelectionIcon}
      <span className="gds-assistant__selection-chip-label">
        {label}
        {snippet ? ':' : ''}
      </span>
      {snippet && (
        <span className="gds-assistant__selection-chip-text">“{snippet}”</span>
      )}
    </div>
  );
}

// ── Composer with Send/Stop toggle ──────────────────────────

function Composer() {
  const threadRuntime = useThreadRuntime();
  const [isRunning, setIsRunning] = useState(false);
  const [wasStopped, setWasStopped] = useState(false);
  const [slashQuery, setSlashQuery] = useState(null);
  // Whether the composer has any text — drives the Send button reveal.
  const [hasText, setHasText] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    return threadRuntime.subscribe(() => {
      const running = threadRuntime.getState().isRunning;
      setIsRunning(running);
      if (!running && wasStopped) {
        const timer = setTimeout(() => setWasStopped(false), 2000);
        return () => clearTimeout(timer);
      }
    });
  }, [threadRuntime, wasStopped]);

  // Persist the composer draft across full-page wp-admin navigations: restore
  // a saved draft on mount, then mirror every composer change to localStorage.
  // Subscribing (vs. hooking onChange) also captures the clear-on-send and
  // clear-on-skill-select transitions, so the draft is dropped once it's sent.
  useEffect(() => {
    const composer = threadRuntime.composer;
    if (!composer?.subscribe || !composer.getState) return undefined;
    try {
      const saved = localStorage.getItem('gds-assistant-draft');
      if (saved && !composer.getState().text && composer.setText) {
        composer.setText(saved);
      }
    } catch {
      // Ignore storage failures (private mode, quota).
    }
    setHasText(!!(composer.getState().text || '').trim());
    return composer.subscribe(() => {
      const text = composer.getState().text || '';
      setHasText(!!text.trim());
      try {
        if (text) {
          localStorage.setItem('gds-assistant-draft', text);
        } else {
          localStorage.removeItem('gds-assistant-draft');
        }
      } catch {
        // Ignore storage failures.
      }
    });
  }, [threadRuntime]);

  const handleCancel = useCallback(() => {
    threadRuntime.cancelRun();
    // Stop also silences any in-flight read-aloud — otherwise the AI keeps
    // talking even after the user pressed Stop, which feels broken.
    cancelTts();
    setWasStopped(true);
  }, [threadRuntime]);

  const handleInputChange = useCallback((e) => {
    const val = e.target?.value ?? e;
    if (typeof val === 'string' && val.startsWith('/')) {
      setSlashQuery(val.slice(1));
    } else {
      setSlashQuery(null);
    }
  }, []);

  const handleSkillSelect = useCallback(
    (skill) => {
      setSlashQuery(null);
      if (skill.model) {
        setModel(skill.model);
      }
      threadRuntime.append({
        role: 'user',
        content: [{type: 'text', text: skill.prompt}],
      });
    },
    [threadRuntime],
  );

  return (
    <ComposerPrimitive.Root className="gds-assistant__composer">
      <ReadAloudController />
      <ApprovalCleanup />
      {slashQuery !== null && (
        <SlashAutocomplete
          query={slashQuery}
          onSelect={handleSkillSelect}
          onDismiss={() => setSlashQuery(null)}
        />
      )}
      <SelectionChip />
      <div className="gds-assistant__attachments">
        <ComposerPrimitive.Attachments
          components={{
            Attachment: ComposerAttachment,
          }}
        />
      </div>
      <ComposerPrimitive.AddAttachment
        className="gds-assistant__attach"
        title="Attach image"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </ComposerPrimitive.AddAttachment>
      <ComposerPrimitive.Input
        ref={inputRef}
        className="gds-assistant__input"
        placeholder="Ask anything... (type / for skills)"
        rows={1}
        onChange={handleInputChange}
      />
      <MicButton />
      {isRunning ?
        <button
          type="button"
          className="gds-assistant__cancel"
          onClick={handleCancel}
          title="Stop generating"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
      : hasText ?
        <ComposerPrimitive.Send className="gds-assistant__send" title="Send">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </ComposerPrimitive.Send>
      : null}
      {wasStopped && !isRunning && (
        <span className="gds-assistant__stopped">Stopped</span>
      )}
    </ComposerPrimitive.Root>
  );
}

// ── Composer attachment chip ─────────────────────────────────

function ComposerAttachment({attachment}) {
  const thumbSrc = attachment?.content?.[0]?.image || '';

  return (
    <AttachmentPrimitive.Root className="gds-assistant__attachment-chip">
      {thumbSrc && (
        <img
          src={thumbSrc}
          alt=""
          className="gds-assistant__attachment-thumb"
        />
      )}
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove className="gds-assistant__attachment-remove">
        &times;
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

// ── Message components ──────────────────────────────────────

function MessageImage({image}) {
  if (!image) return null;
  return (
    <img src={image} alt="Attached" className="gds-assistant__message-image" />
  );
}

// Out-of-band notes (e.g. the Undo button's "↩ Reverted…") are stored as user
// messages so the model sees them, but render as a centered system line rather
// than a user bubble. The leading ↩ is our marker.
const SYSTEM_NOTE_MARKER = '↩';

function UserMessage() {
  const systemNote = useMessage((s) => {
    const text = (s.content || [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join('')
      .trim();
    return text.startsWith(SYSTEM_NOTE_MARKER) ? text : null;
  });

  if (systemNote) {
    return <div className="gds-assistant__system-note">{systemNote}</div>;
  }

  return (
    <MessagePrimitive.Root className="gds-assistant__message gds-assistant__message--user">
      <MessagePrimitive.Content
        components={{Text: UserMessageText, Image: MessageImage}}
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
  const isRunning = useMessage((s) => s.status?.type === 'running');
  const isLast = useMessage((s) => s.isLast);
  const role = useMessage((s) => s.role);

  // Streaming assistant message: no time yet — TypingIndicator covers it.
  if (isRunning && isLast && role === 'assistant') return null;

  if (!createdAt || new Date(createdAt).getTime() < 100000) return null;
  const date = new Date(createdAt);
  return (
    <span
      className="gds-assistant__message-time"
      title={date.toLocaleString('sv-SE')}
    >
      {formatMessageTime(date.getTime())}
    </span>
  );
}

function UserMessageText({text}) {
  // Long skill prompts: show collapsed with expand toggle
  const isLong = text.length > 200;
  const [expanded, setExpanded] = useState(!isLong);

  if (!isLong) {
    return <p style={{whiteSpace: 'pre-wrap'}}>{text}</p>;
  }

  return (
    <div>
      <p style={{whiteSpace: 'pre-wrap'}}>
        {expanded ? text : text.slice(0, 120) + '...'}
      </p>
      <button
        type="button"
        className="gds-assistant__expand-btn"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'Show less' : 'Show full prompt'}
      </button>
    </div>
  );
}

function AssistantMessage() {
  // assistant-ui injects an empty assistant message while a stream warms up.
  // Don't render an empty bubble (with its copy button) for it — the
  // thread-level TypingIndicator covers that gap. We render once there's any
  // real content (text, a tool call, or an image).
  const isEmpty = useMessage((s) => {
    const parts = s.content || [];
    return !parts.some(
      (p) =>
        (p.type === 'text' && p.text && p.text.trim()) ||
        p.type === 'tool-call' ||
        p.type === 'image',
    );
  });
  if (isEmpty) return null;

  return (
    <MessagePrimitive.Root className="gds-assistant__message gds-assistant__message--assistant">
      <CopyMessageButton />
      <MessagePrimitive.Content
        components={{
          Text: AssistantMessageText,
          // assistant-ui routes tool-call parts through `tools.Fallback`
          // (not `ToolCallUI` — that key was a no-op, which is why tool calls
          // previously only appeared as the adapter's inline text).
          tools: {Fallback: ToolCallFallback},
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
  abbr: ['class', 'title'],
};

function AssistantMessageText({text}) {
  return (
    <StreamdownTextPrimitive
      text={text}
      allowedTags={STREAMDOWN_ALLOWED_TAGS}
    />
  );
}

// ── Copy message button ─────────────────────────────────────

/**
 * Serialize a message's content parts into clipboard text. Built from the
 * message DATA (not the rendered DOM) so it captures each tool call's full
 * request + response even while the card is collapsed — handy for pasting a
 * tool exchange into a bug report.
 * @param parts
 */
function messageToCopyText(parts) {
  return (parts || [])
    .map((p) => {
      if (p.type === 'text') return p.text || '';
      if (p.type === 'tool-call') {
        const lines = [`Tool: ${p.toolName || 'unknown'}`];
        const args = p.args || {};
        if (Object.keys(args).length > 0) {
          lines.push(`Request:\n${JSON.stringify(args, null, 2)}`);
        }
        if (p.result !== undefined) {
          const result =
            typeof p.result === 'string' ?
              p.result
            : JSON.stringify(p.result, null, 2);
          lines.push(`Response:\n${result}`);
        }
        return lines.join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Copy text to the clipboard, resolving true on success. Falls back to a hidden
 * textarea + execCommand when the async Clipboard API is unavailable or rejects
 * (e.g. headless CI, where the document isn't focused) so the "Copied!"
 * confirmation stays reliable.
 *
 * @param {string} text Text to copy.
 * @return {Promise<boolean>} Whether the copy succeeded.
 */
function copyToClipboard(text) {
  // execCommand first: it's synchronous, so it stays inside the click's
  // user-gesture window. The async Clipboard API loses that gesture after its
  // first await, so using it as the *fallback* (after a rejection) no-ops in
  // headless CI. Deprecated but still works everywhere, including headless.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return Promise.resolve(true);
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
      if (!ok) return;
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
      {copied ? '✓' : '⎘'}
    </button>
  );
}

// ── Tool call fallback UI ───────────────────────────────────

/**
 * Short one-line hint shown next to the tool name in the collapsed summary.
 * Picks up to 3 identifying args so a bulk sequence of the same tool is
 * distinguishable at a glance (e.g. `id=26520 menu_order=6`).
 * @param args
 */
function summarizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const entries = Object.entries(args);
  if (entries.length === 0) return '';

  // Prioritize fields that identify what the call targets.
  const preferred = [
    'id',
    'post_id',
    'term_id',
    'menu_id',
    'parent_item_id',
    'conversation_uuid',
    'type',
    'post_type',
    'taxonomy',
    'title',
    'name',
    'slug',
    'position',
    'menu_order',
    'status',
  ];
  const sorted = entries.slice().sort(([a], [b]) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return sorted
    .slice(0, 3)
    .map(([k, v]) => {
      let str;
      if (typeof v === 'string') {
        str = v.length > 24 ? `${v.slice(0, 21)}…` : v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        str = String(v);
      } else if (v === null) {
        str = 'null';
      } else if (Array.isArray(v)) {
        str = `[${v.length}]`;
      } else {
        str = '{…}';
      }
      return `${k}=${str}`;
    })
    .join(' ');
}

/**
 * Hook: live snapshot of the inline-edit approval entry for this tool call,
 * if any. Re-renders the host card whenever the queue changes.
 */
function usePendingApproval(toolCallId) {
  const [entry, setEntry] = useState(() => getApproval(toolCallId));
  useEffect(() => {
    const sync = () => setEntry(getApproval(toolCallId));
    sync();
    return subscribeApprovals(sync);
  }, [toolCallId]);
  return entry;
}

/**
 * Diff card content for an editor write tool waiting on inline approval.
 * Plain text "Before" / "After" panes — character-level highlighting is a
 * follow-up; v1 just shows the two states side by side so the user can see
 * what's about to change before they click Apply.
 */
function EditApprovalCard({entry, toolCallId}) {
  if (!entry) return null;
  const showBefore = entry.kind === 'replace' || entry.kind === 'attrs' || entry.kind === 'post' || entry.kind === 'recover';
  return (
    <div className="gds-assistant__edit-diff">
      <div className="gds-assistant__edit-diff-title">
        {entry.summary || 'Proposed edit'}
      </div>
      <div className="gds-assistant__edit-diff-panes">
        {showBefore && (
          <div className="gds-assistant__edit-diff-pane gds-assistant__edit-diff-pane--before">
            <div className="gds-assistant__edit-diff-label">Before</div>
            <pre className="gds-assistant__edit-diff-content">
              {entry.before || '(empty)'}
            </pre>
          </div>
        )}
        <div className="gds-assistant__edit-diff-pane gds-assistant__edit-diff-pane--after">
          <div className="gds-assistant__edit-diff-label">After</div>
          <pre className="gds-assistant__edit-diff-content">
            {entry.after || '(empty)'}
          </pre>
        </div>
      </div>
      <div className="gds-assistant__edit-diff-actions">
        <button
          type="button"
          className="gds-assistant__edit-diff-btn gds-assistant__edit-diff-btn--reject"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            resolveApproval(toolCallId, false);
          }}
        >
          Reject
        </button>
        <button
          type="button"
          className="gds-assistant__edit-diff-btn gds-assistant__edit-diff-btn--apply"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            resolveApproval(toolCallId, true);
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function ToolCallFallback({toolCallId, toolName, args, result, isError}) {
  const argsHint = summarizeArgs(args);
  const ctx = useContext(UndoContext);
  const {undoableActions, onUndo, pendingApprovalIds} = ctx;
  const needsApproval = !!(toolCallId && pendingApprovalIds?.has(toolCallId));
  const editApproval = usePendingApproval(toolCallId);
  const undo = toolCallId ? undoableActions?.[toolCallId] : null;

  return (
    <div
      className={`gds-assistant__tool-call ${isError ? 'gds-assistant__tool-call--error' : ''} ${needsApproval || editApproval ? 'gds-assistant__tool-call--approval' : ''}`}
    >
      <details open={!!editApproval || undefined}>
        <summary className="gds-assistant__tool-call-summary">
          <span className="gds-assistant__tool-call-name">{toolName}</span>
          {argsHint && (
            <span className="gds-assistant__tool-call-args-hint">
              {argsHint}
            </span>
          )}
          {needsApproval && (
            <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--approval">
              Approval required
            </span>
          )}
          {!needsApproval && editApproval && (
            <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--approval">
              Awaiting confirmation
            </span>
          )}
          {!needsApproval && !editApproval && result === undefined && (
            <span className="gds-assistant__tool-call-status">Running...</span>
          )}
          {!needsApproval && result !== undefined && !isError && (
            <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--done">
              Done
            </span>
          )}
          {!needsApproval && isError && (
            <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--error">
              Error
            </span>
          )}
          {/* Per-action Undo (only for reversible, successful actions). */}
          {undo &&
            onUndo &&
            !needsApproval &&
            !isError &&
            (undo.undone ?
              <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--undone">
                Undone
              </span>
            : <button
                type="button"
                className="gds-assistant__tool-undo-btn"
                disabled={undo.pending}
                title={undo.label}
                onClick={(e) => {
                  // Inside <summary>: don't toggle the details on click.
                  e.preventDefault();
                  e.stopPropagation();
                  onUndo(toolCallId, undo.auditId);
                }}
              >
                {undo.pending ? 'Undoing…' : '↩ Undo'}
              </button>)}
        </summary>
        {editApproval && (
          <EditApprovalCard entry={editApproval} toolCallId={toolCallId} />
        )}
        {args && Object.keys(args).length > 0 && (
          <pre className="gds-assistant__tool-call-args">
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
        {!needsApproval && result !== undefined && (
          <pre className="gds-assistant__tool-call-result">
            {typeof result === 'string' ?
              result
            : JSON.stringify(result, null, 2)}
          </pre>
        )}
        {undo?.undone && undo.caveats?.length > 0 && (
          <div className="gds-assistant__tool-undo-caveats">
            {undo.caveats.map((c, i) => (
              <div key={i}>⚠ {c}</div>
            ))}
          </div>
        )}
        {undo?.error && (
          <div className="gds-assistant__tool-undo-error">
            Undo failed: {undo.error}
          </div>
        )}
      </details>
    </div>
  );
}
