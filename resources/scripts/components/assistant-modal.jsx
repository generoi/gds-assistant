import {
  AssistantModalPrimitive,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useThreadRuntime,
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
 */
export function AssistantModal({
  onNewChat,
  onLoadConversation,
  systemContext,
  onSystemContextChange,
}) {
  // Keyboard shortcut: Cmd+K / Ctrl+K to toggle modal
  const triggerRef = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        triggerRef.current?.click();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <AssistantModalPrimitive.Root>
      <AssistantModalPrimitive.Trigger
        ref={triggerRef}
        className="gds-assistant__trigger"
      >
        <span className="gds-assistant__trigger-icon">✦</span>
      </AssistantModalPrimitive.Trigger>

      <AssistantModalPrimitive.Content
        className="gds-assistant__panel"
        sideOffset={16}
      >
        <Thread
          onNewChat={onNewChat}
          onLoadConversation={onLoadConversation}
          systemContext={systemContext}
          onSystemContextChange={onSystemContextChange}
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

  return (
    <ThreadPrimitive.Root className="gds-assistant__thread">
      <div className="gds-assistant__header">
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
  if (!conversations.length) {
    return (
      <div className="gds-assistant__history-list">
        <p className="gds-assistant__history-empty">No previous chats</p>
      </div>
    );
  }

  return (
    <div className="gds-assistant__history-list">
      {conversations.map((conv) => (
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

// ── Message components ──────────────────────────────────────

function UserMessage() {
  return (
    <MessagePrimitive.Root className="gds-assistant__message gds-assistant__message--user">
      <MessagePrimitive.Content components={{Text: UserMessageText}} />
    </MessagePrimitive.Root>
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
    </MessagePrimitive.Root>
  );
}

function AssistantMessageText({text}) {
  return <StreamdownTextPrimitive text={text} />;
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

function ToolCallFallback({toolName, args, result, isError}) {
  return (
    <div
      className={`gds-assistant__tool-call ${isError ? 'gds-assistant__tool-call--error' : ''}`}
    >
      <details>
        <summary className="gds-assistant__tool-call-summary">
          <span className="gds-assistant__tool-call-name">
            {toolName?.replace('__', '/')}
          </span>
          {result === undefined && (
            <span className="gds-assistant__tool-call-status">Running...</span>
          )}
          {result !== undefined && !isError && (
            <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--done">
              Done
            </span>
          )}
          {isError && (
            <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--error">
              Error
            </span>
          )}
        </summary>
        {args && (
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
