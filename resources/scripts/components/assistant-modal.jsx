import {
  AssistantModalPrimitive,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  AttachmentPrimitive,
  useThreadRuntime,
  useMessage,
} from '@assistant-ui/react';
import {StreamdownTextPrimitive} from '@assistant-ui/react-streamdown';
import {useState, useEffect, useCallback, useRef} from '@wordpress/element';
import {
  onUsageUpdate,
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
    const { width, height } = JSON.parse(raw);
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
 * Read persisted panel position (top/left in px). Returns null to keep
 * the CSS default (bottom-right anchored). Clamps to keep the panel
 * on-screen after window resizes / monitor changes.
 */
function getStoredPanelPosition() {
  try {
    const raw = localStorage.getItem('gds-assistant-panel-position');
    if (!raw) return null;
    const { top, left } = JSON.parse(raw);
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

export function AssistantModal({
  onNewChat,
  onLoadConversation,
  systemContext,
  onSystemContextChange,
  onApproveToolCall,
  onDenyToolCall,
  pendingApprovals,
}) {
  // Keyboard shortcut: Cmd+K / Ctrl+K to toggle modal
  // Also open when a conversation is resumed
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

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
      // Switch from bottom-right anchoring to top-left positioning.
      node.style.top = `${pos.top}px`;
      node.style.left = `${pos.left}px`;
      node.style.bottom = 'auto';
      node.style.right = 'auto';
    }
  }, []);

  // Drag the panel around by its header. Starts a drag only on empty
  // header space — clicks on buttons inside the header still work
  // normally because they stop propagation naturally.
  const onHeaderMouseDown = useCallback((e) => {
    // Only start drag on primary button, and only when the target is
    // the header itself or a non-interactive span — not a button/input.
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest('button, input, textarea, select, a')) return;

    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const onMove = (ev) => {
      const maxLeft = window.innerWidth - 40;
      const maxTop = window.innerHeight - 40;
      const left = Math.max(0, Math.min(maxLeft, ev.clientX - offsetX));
      const top = Math.max(0, Math.min(maxTop, ev.clientY - offsetY));
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem(
          'gds-assistant-panel-position',
          JSON.stringify({ top: r.top, left: r.left }),
        );
      } catch {
        // Private browsing etc.
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
    } catch {}
    const panel = panelRef.current;
    if (panel) {
      panel.style.top = '';
      panel.style.left = '';
      panel.style.bottom = '';
      panel.style.right = '';
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
    <AssistantModalPrimitive.Root>
      <AssistantModalPrimitive.Trigger
        ref={triggerRef}
        className="gds-assistant gds-assistant__trigger"
      >
        <span className="gds-assistant__trigger-icon">✦</span>
      </AssistantModalPrimitive.Trigger>

      <AssistantModalPrimitive.Content
        ref={setPanelRef}
        className="gds-assistant gds-assistant__panel"
        sideOffset={16}
      >
        <div
          className="gds-assistant__resize-handle"
          onMouseDown={onResizeStart}
          title="Drag to resize"
          aria-label="Resize chat panel"
        />
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
        />
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
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
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [activeTitle, setActiveTitle] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [showSkills, setShowSkills] = useState(false);

  const toggleHistory = useCallback(async () => {
    if (!showHistory) {
      const list = await fetchConversations();
      setConversations(list);
    }
    setShowHistory((v) => !v);
  }, [showHistory]);

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
    const state = threadRuntime.getState();
    const msgs = state?.messages || [];
    if (!msgs.length) return;

    const lines = [
      `# Conversation Export\n`,
      `_Exported: ${new Date().toLocaleString()}_\n`,
      `---\n`,
    ];

    for (const msg of msgs) {
      const role = msg.role === 'user' ? '## User' : '## Assistant';
      lines.push(`\n${role}\n`);

      const parts = msg.content || [];
      for (const part of parts) {
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
            lines.push(
              `\n_${status}:_ ${typeof part.result === 'string' ? part.result : JSON.stringify(part.result)}`,
            );
          }
          lines.push('\n');
        }
      }
      lines.push('\n\n---\n');
    }

    const md = lines.join('');
    const blob = new Blob([md], {type: 'text/markdown'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
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
            onClick={() => setShowSkills((v) => !v)}
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
          </button>
          <button
            type="button"
            className={`gds-assistant__header-btn ${showContext ? 'gds-assistant__header-btn--active' : ''}`}
            onClick={() => setShowContext((v) => !v)}
            title="System context"
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
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
          <button
            type="button"
            className="gds-assistant__header-btn"
            onClick={toggleHistory}
            title="Chat history"
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
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
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
          </button>
          <button
            type="button"
            className="gds-assistant__header-btn"
            onClick={handleExport}
            title="Export as Markdown"
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
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {showContext && (
        <SystemContextInput
          value={systemContext}
          onChange={onSystemContextChange}
        />
      )}

      {showSkills && <SkillsList />}

      {showHistory && (
        <ConversationList
          conversations={conversations}
          onSelect={handleSelect}
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

function SystemContextInput({value, onChange}) {
  return (
    <div className="gds-assistant__context">
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

function SkillsList() {
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
    },
    [threadRuntime],
  );

  if (!skills.length) {
    return (
      <div className="gds-assistant__skills-list">
        <p className="gds-assistant__history-empty">
          No skills yet. Ask the assistant to create one!
        </p>
      </div>
    );
  }

  return (
    <div className="gds-assistant__skills-list">
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

  useEffect(() => {
    return threadRuntime.subscribe(() => {
      setIsRunning(threadRuntime.getState().isRunning);
    });
  }, [threadRuntime]);

  if (!isRunning) return null;

  return (
    <div className="gds-assistant__typing">
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

function ConversationList({conversations, onSelect}) {
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
        <p className="gds-assistant__history-empty">No previous chats</p>
      </div>
    );
  }

  return (
    <div className="gds-assistant__history-list">
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
        title={`Input: ${usage.inputTokens.toLocaleString()} / Output: ${usage.outputTokens.toLocaleString()}`}
      >
        {total.toLocaleString()} tokens &middot; {formatCost(usage.cost)}
        {overBudget ? ' ⚠' : ''}
      </span>
    </div>
  );
}

// ── Composer with Send/Stop toggle ──────────────────────────

function Composer() {
  const threadRuntime = useThreadRuntime();
  const [isRunning, setIsRunning] = useState(false);
  const [wasStopped, setWasStopped] = useState(false);
  const [slashQuery, setSlashQuery] = useState(null);
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

  const handleCancel = useCallback(() => {
    threadRuntime.cancelRun();
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
      {slashQuery !== null && (
        <SlashAutocomplete
          query={slashQuery}
          onSelect={handleSkillSelect}
          onDismiss={() => setSlashQuery(null)}
        />
      )}
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
      : <ComposerPrimitive.Send className="gds-assistant__send" title="Send">
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
      }
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

function UserMessage() {
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
  return (
    <MessagePrimitive.Root className="gds-assistant__message gds-assistant__message--assistant">
      <CopyMessageButton />
      <MessagePrimitive.Content
        components={{
          Text: AssistantMessageText,
          ToolCallUI: ToolCallFallback,
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

function CopyMessageButton() {
  const [copied, setCopied] = useState(false);
  const messageRef = useRef(null);

  const handleCopy = useCallback(() => {
    // Walk up to the message root and extract text content
    const root = messageRef.current?.closest('.gds-assistant__message');
    if (!root) return;
    const text = root.innerText || root.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <button
      ref={messageRef}
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

function ToolCallFallback({toolName, args, result, isError, status}) {
  const needsApproval = status?.type === 'requires-action';
  const argsHint = summarizeArgs(args);

  return (
    <div
      className={`gds-assistant__tool-call ${isError ? 'gds-assistant__tool-call--error' : ''} ${needsApproval ? 'gds-assistant__tool-call--approval' : ''}`}
    >
      <details open={needsApproval}>
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
          {!needsApproval && result === undefined && (
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
        </summary>
        {args && Object.keys(args).length > 0 && (
          <pre className="gds-assistant__tool-call-args">
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
        {result !== undefined && (
          <pre className="gds-assistant__tool-call-result">
            {typeof result === 'string' ?
              result
            : JSON.stringify(result, null, 2)}
          </pre>
        )}
      </details>
    </div>
  );
}
