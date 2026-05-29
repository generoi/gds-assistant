/**
 * Composer — the bottom-of-the-panel input UI.
 *
 * Bundles: the input field with its Send/Stop toggle, the editor-selection
 * chip (shown above the input when the user has a block or text selection),
 * the `/skill` slash-command autocomplete, attachment chips, the mic button,
 * and the read-aloud subscriber.
 *
 * Everything here is interactive and shares the composer runtime / thread
 * runtime, so co-locating keeps the wiring simple. Skill data is pulled from
 * the shared {@link ./skills-cache} module so both the dropdown here and the
 * Skills panel see the same list without re-fetching.
 */

import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useThreadRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "@wordpress/element";

import { useEditorSelection } from "../hooks/use-editor-selection";
import { setModel } from "../hooks/use-runtime-adapter";
import { cancelTts } from "../hooks/use-tts";
import { MicButton } from "./MicButton";
import { ReadAloudController } from "./ReadAloudController";
import { getSkills, getSkillsFresh } from "./skills-cache";

// ── Slash command autocomplete ───────────────────────────────

function SlashAutocomplete({ query, onSelect, onDismiss }) {
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
      if (e.key === "Escape") {
        onDismiss();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onDismiss]);

  if (!filtered.length) {
    return null;
  }

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
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max - 1).trimEnd() + "…";
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
  if (!selection) {
    return null;
  }

  let label;
  let snippet;
  let title;

  if (selection.mode === "multi-block") {
    const labels = selection.blockLabels || [];
    const head = labels.slice(0, 3).join(", ");
    const more = labels.length > 3 ? ` +${labels.length - 3} more` : "";
    label = `Selected ${selection.count} blocks`;
    snippet = labels.length ? `${head}${more}` : "";
    title = `Selected ${selection.count} blocks: ${labels.join(", ")}`;
  } else {
    const text =
      selection.mode === "text-range"
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
        {snippet ? ":" : ""}
      </span>
      {snippet && (
        <span className="gds-assistant__selection-chip-text">“{snippet}”</span>
      )}
    </div>
  );
}

// ── Composer attachment chip ─────────────────────────────────

function ComposerAttachment({ attachment }) {
  const thumbSrc = attachment?.content?.[0]?.image || "";

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

// ── Composer with Send/Stop toggle ──────────────────────────

// Renders the trailing action button: Stop while a turn is streaming,
// Send when the composer has text, nothing otherwise. Extracted so the
// state machine reads as a flat if/else instead of a nested ternary in JSX.
function renderActionButton(isRunning, hasText, handleCancel) {
  if (isRunning) {
    return (
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
    );
  }
  if (hasText) {
    return (
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
    );
  }
  return null;
}

export function Composer() {
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
    if (!composer?.subscribe || !composer.getState) {
      return undefined;
    }
    try {
      const saved = localStorage.getItem("gds-assistant-draft");
      if (saved && !composer.getState().text && composer.setText) {
        composer.setText(saved);
      }
    } catch {
      // Ignore storage failures (private mode, quota).
    }
    setHasText(!!(composer.getState().text || "").trim());
    return composer.subscribe(() => {
      const text = composer.getState().text || "";
      setHasText(!!text.trim());
      try {
        if (text) {
          localStorage.setItem("gds-assistant-draft", text);
        } else {
          localStorage.removeItem("gds-assistant-draft");
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
    if (typeof val === "string" && val.startsWith("/")) {
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
        role: "user",
        content: [{ type: "text", text: skill.prompt }],
      });
    },
    [threadRuntime],
  );

  return (
    <ComposerPrimitive.Root className="gds-assistant__composer">
      <ReadAloudController />
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
      {renderActionButton(isRunning, hasText, handleCancel)}
      {wasStopped && !isRunning && (
        <span className="gds-assistant__stopped">Stopped</span>
      )}
    </ComposerPrimitive.Root>
  );
}
