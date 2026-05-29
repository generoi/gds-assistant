/**
 * Side panels and selectors rendered alongside the chat thread.
 *
 * Bundled together because they all live in the same modal chrome and share
 * a small handful of helpers (PanelHeader, formatCost, relativeTime). Splitting
 * each into its own file would be more import wiring than it's worth — they
 * never depend on each other's internals.
 *
 * Exports:
 *   - EmptyState       — first-paint suggestions when there are no messages
 *   - PanelHeader      — collapsible header for the slide-in side panels
 *   - SystemContextInput — textarea bound to a system-context string
 *   - SkillsList       — slide-in "Skills" panel
 *   - TypingIndicator  — three-dot indicator + run status hint
 *   - ConversationList — slide-in "Chat history" panel
 *   - ModelSelector    — provider/model dropdown in the modal toolbar
 *   - MaxTokensSelector — max-output-token dropdown
 *   - UsageBar         — tokens-used readout with over-budget warning
 *   - SUGGESTIONS      — re-exported because the empty state uses it
 */

import { useThreadRuntime } from "@assistant-ui/react";
import { useCallback, useEffect, useState } from "@wordpress/element";

import {
  getMaxTokens,
  getModel,
  onRunStatus,
  onUsageUpdate,
  setMaxTokens,
  setModel,
} from "../hooks/use-runtime-adapter";
import { getSkills, getSkillsFresh } from "./skills-cache";

// ── Constants ────────────────────────────────────────────────

// Dollar threshold for the usage bar's "you've spent a lot this session" hint.
const COST_WARNING_THRESHOLD = 0.5; // USD

// First-paint prompt suggestions for the empty state.
export const SUGGESTIONS = [
  "List all draft pages",
  "Audit missing translations",
  "Show recent form submissions",
  "How many products are published?",
];

// ── Empty state with prompt suggestions ─────────────────────

export function EmptyState() {
  const threadRuntime = useThreadRuntime();

  const handleSuggestion = useCallback(
    (text) => {
      threadRuntime.append({
        role: "user",
        content: [{ type: "text", text }],
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

// ── Panel header ────────────────────────────────────────────

/**
 * Small header for the slide-in panels (skills, history, system context) so
 * each one carries its own title and an unambiguous close (×) — the panels
 * are opened from the "⋯" menu, so without this there's no visible way to
 * dismiss them.
 */
export function PanelHeader({ title, onClose }) {
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

// ── System context input ────────────────────────────────────

export function SystemContextInput({ value, onChange, onClose }) {
  return (
    <div className="gds-assistant__context">
      <PanelHeader title="System context" onClose={onClose} />
      <textarea
        className="gds-assistant__context-input"
        placeholder='Add context for this chat, e.g. "You&apos;re helping me restructure the Finnish product pages"'
        value={value || ""}
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
  if (dollars < 0.001) return "<$0.001";
  return `~$${dollars.toFixed(3)}`;
}

/**
 * Format a date as relative time (5m ago, 2h ago, Yesterday, Apr 10).
 *
 * @param {string} dateStr UTC datetime string.
 * @return {string} Formatted relative time.
 */
function relativeTime(dateStr) {
  const date = new Date(dateStr + "Z");
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Skills list panel ────────────────────────────────────────

export function SkillsList({ onUsed, onClose }) {
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
        role: "user",
        content: [{ type: "text", text: skill.prompt }],
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
                  {" "}
                  ({skill.model.split(":").pop()})
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

export function TypingIndicator() {
  const threadRuntime = useThreadRuntime();
  const [isRunning, setIsRunning] = useState(false);
  // What's happening right now ("Reading the editor…", "Editing the document…")
  // so a slow turn shows progress instead of three blind dots.
  const [status, setStatus] = useState("");

  useEffect(() => {
    return threadRuntime.subscribe(() => {
      setIsRunning(threadRuntime.getState().isRunning);
    });
  }, [threadRuntime]);

  useEffect(() => onRunStatus(setStatus), []);

  if (!isRunning) return null;

  return (
    <div className="gds-assistant__typing">
      {status ? (
        <span className="gds-assistant__typing-status">{status}</span>
      ) : null}
      <span className="gds-assistant__typing-dot" />
      <span className="gds-assistant__typing-dot" />
      <span className="gds-assistant__typing-dot" />
    </div>
  );
}

// ── Conversation history list ───────────────────────────────

export function ConversationList({ conversations, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const filtered = search
    ? conversations.filter((c) =>
        (c.title || "").toLowerCase().includes(search.toLowerCase()),
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
            {conv.title || "Untitled"}
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
  return window.gdsAssistant?.models || { providers: [], default: null };
}

function getDefaultModelKey() {
  return getModelConfig().default || "";
}

export function ModelSelector() {
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
              {m.label} {m.tier || ""}
              {m.capabilityTier === "read" ? " (read-only)" : ""}
              {m.capabilityTier === "full" ? " (full access)" : ""}
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
    { value: 0, label: formatK(def) },
    ...presets
      .filter((v) => v !== def)
      .map((v) => ({ value: v, label: formatK(v) })),
  ];
}

export function MaxTokensSelector() {
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

export function UsageBar() {
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
        className={overBudget ? "gds-assistant__usage--warn" : ""}
        title={`Input: ${usage.inputTokens.toLocaleString()} / Output: ${usage.outputTokens.toLocaleString()} · ${formatCost(
          usage.cost,
        )}`}
      >
        {total.toLocaleString()} tokens{overBudget ? " ⚠" : ""}
      </span>
    </div>
  );
}
