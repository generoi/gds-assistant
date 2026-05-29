/**
 * ToolCallFallback — render a tool call inside an assistant message.
 *
 * assistant-ui routes any tool-call message part through `tools.Fallback`
 * (registered in {@link ./assistant-modal#AssistantMessage}). This component
 * shows the tool name, a short args hint, status (Running / Done / Error /
 * Approval required), an optional unified diff (for editor write tools),
 * the raw request/response when no diff is available, and a per-tool Undo
 * button when the action was registered as undoable.
 *
 * Per-tool undo state is pulled from {@link ./UndoContext#UndoContext}
 * because assistant-ui instantiates this component too deep in the tree to
 * receive it via props.
 */

import { Fragment, useContext, useMemo } from "@wordpress/element";

import {
  collapseUnchanged,
  diffLines,
  pairModifiedLines,
} from "../editor/diff";
import { UndoContext } from "./UndoContext";

interface ToolDiff {
  before?: string;
  after?: string;
  summary?: string;
  [key: string]: unknown;
}

/**
 * Short one-line hint shown next to the tool name in the collapsed summary.
 * Picks up to 3 identifying args so a bulk sequence of the same tool is
 * distinguishable at a glance (e.g. `id=26520 menu_order=6`).
 */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "";
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) {
    return "";
  }

  // Prioritize fields that identify what the call targets.
  const preferred = [
    "id",
    "post_id",
    "term_id",
    "menu_id",
    "parent_item_id",
    "conversation_uuid",
    "type",
    "post_type",
    "taxonomy",
    "title",
    "name",
    "slug",
    "position",
    "menu_order",
    "status",
  ];
  const sorted = entries.slice().sort(([a], [b]) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai === -1 && bi === -1) {
      return 0;
    }
    if (ai === -1) {
      return 1;
    }
    if (bi === -1) {
      return -1;
    }
    return ai - bi;
  });

  return sorted
    .slice(0, 3)
    .map(([k, v]) => {
      let str: string;
      if (typeof v === "string") {
        str = v.length > 24 ? `${v.slice(0, 21)}…` : v;
      } else if (typeof v === "number" || typeof v === "boolean") {
        str = String(v);
      } else if (v === null) {
        str = "null";
      } else if (Array.isArray(v)) {
        str = `[${v.length}]`;
      } else {
        str = "{…}";
      }
      return `${k}=${str}`;
    })
    .join(" ");
}

// Map a row type (add / del / gap / eq) to its CSS modifier + glyph. Extracted
// from the DiffViewer JSX to keep that switch as flat one-liners.
const DIFF_ROW_CLASS: Record<string, string> = {
  add: "gds-assistant__edit-diff-line--add",
  del: "gds-assistant__edit-diff-line--del",
  gap: "gds-assistant__edit-diff-line--gap",
};
const DIFF_ROW_PREFIX: Record<string, string> = {
  add: "+",
  del: "-",
  gap: "⋮",
};
const diffRowClass = (type: string): string =>
  DIFF_ROW_CLASS[type] || "gds-assistant__edit-diff-line--eq";
const diffRowPrefix = (type: string): string => DIFF_ROW_PREFIX[type] || " ";

interface DiffViewerProps {
  diff: ToolDiff | null;
}

/**
 * Unified diff display for an editor write tool's result. Reads `diff` from
 * the tool result (set by editor-bridge after the mutation applied) — shows
 * line-level +/- with surrounding context collapsed to "…" stubs. Pure
 * presentation; no buttons, no state.
 */
function DiffViewer({ diff }: DiffViewerProps): JSX.Element | null {
  const rows = useMemo(() => {
    if (!diff) {
      return [];
    }
    const lines = collapseUnchanged(
      diffLines(diff.before || "", diff.after || ""),
      2,
    );
    return pairModifiedLines(lines);
  }, [diff]);
  if (!diff) {
    return null;
  }
  return (
    <div className="gds-assistant__edit-diff">
      {diff.summary && (
        <div className="gds-assistant__edit-diff-title">{diff.summary}</div>
      )}
      {/* `<div>` not `<pre>` so we don't inherit the assistant-message-scoped
          dark `pre` theme; `white-space: pre-wrap` on each text span preserves
          indentation without dragging the dark colour scheme in. */}
      <div className="gds-assistant__edit-diff-unified">
        {rows.map((row, i) => {
          if (row.type === "mod") {
            // Render the pair as two rows (red + green) with inline word
            // highlighting — git's --word-diff. Unchanged tokens stay on the
            // row's light tint; changed tokens light up darker.
            const delTokens = row.words.filter(
              (w: { type: string }) => w.type !== "add",
            );
            const addTokens = row.words.filter(
              (w: { type: string }) => w.type !== "del",
            );
            return (
              <Fragment key={i}>
                <div className="gds-assistant__edit-diff-line gds-assistant__edit-diff-line--del">
                  <span className="gds-assistant__edit-diff-prefix">-</span>
                  <span className="gds-assistant__edit-diff-text">
                    {delTokens.map(
                      (tok: { type: string; text: string }, k: number) => (
                        <span
                          key={k}
                          className={
                            tok.type === "del"
                              ? "gds-assistant__edit-diff-word--del"
                              : "gds-assistant__edit-diff-word--eq"
                          }
                        >
                          {tok.text}
                        </span>
                      ),
                    )}
                  </span>
                </div>
                <div className="gds-assistant__edit-diff-line gds-assistant__edit-diff-line--add">
                  <span className="gds-assistant__edit-diff-prefix">+</span>
                  <span className="gds-assistant__edit-diff-text">
                    {addTokens.map(
                      (tok: { type: string; text: string }, k: number) => (
                        <span
                          key={k}
                          className={
                            tok.type === "add"
                              ? "gds-assistant__edit-diff-word--add"
                              : "gds-assistant__edit-diff-word--eq"
                          }
                        >
                          {tok.text}
                        </span>
                      ),
                    )}
                  </span>
                </div>
              </Fragment>
            );
          }
          // Solo line: eq / add / del / gap — same as before.
          const cls = diffRowClass(row.type);
          const prefix = diffRowPrefix(row.type);
          return (
            <div key={i} className={`gds-assistant__edit-diff-line ${cls}`}>
              <span className="gds-assistant__edit-diff-prefix">{prefix}</span>
              <span className="gds-assistant__edit-diff-text">{row.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface ToolCallFallbackProps {
  toolCallId?: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: string | Record<string, unknown>;
  isError?: boolean;
}

export function ToolCallFallback({
  toolCallId,
  toolName,
  args,
  result,
  isError,
}: ToolCallFallbackProps): JSX.Element {
  const argsHint = summarizeArgs(args);
  const ctx = useContext(UndoContext);
  const { undoableActions, onUndo, onRetry, retryingIds, pendingApprovalIds } =
    ctx;
  const needsApproval = !!(toolCallId && pendingApprovalIds?.has(toolCallId));
  const diff: ToolDiff | null =
    result && typeof result === "object" && "diff" in result
      ? ((result as { diff?: ToolDiff }).diff ?? null)
      : null;
  const undo = toolCallId ? undoableActions?.[toolCallId] : null;
  const isRetrying = !!(toolCallId && retryingIds?.has(toolCallId));

  return (
    <div
      className={`gds-assistant__tool-call ${
        isError ? "gds-assistant__tool-call--error" : ""
      } ${needsApproval ? "gds-assistant__tool-call--approval" : ""}`}
    >
      <details open={!!diff || undefined}>
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
          {/* Retry — only meaningful on errored, completed calls. The retry
              handler decides whether the tool is actually re-runnable; for
              server-side tools we alert that re-running isn't supported yet.
              See use-runtime-adapter `retryToolCall`. */}
          {isError && onRetry && !needsApproval && toolCallId && (
            <button
              type="button"
              className="gds-assistant__tool-retry-btn"
              disabled={isRetrying}
              title={`Re-run ${toolName} with the same arguments`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRetry(toolCallId);
              }}
            >
              {isRetrying ? "Retrying…" : "↻ Retry"}
            </button>
          )}
          {/* Per-action Undo (only for reversible, successful actions). */}
          {undo &&
            onUndo &&
            toolCallId &&
            !needsApproval &&
            !isError &&
            (undo.undone ? (
              <span className="gds-assistant__tool-call-status gds-assistant__tool-call-status--undone">
                Undone
              </span>
            ) : (
              <button
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
                {undo.pending ? "Undoing…" : "↩ Undo"}
              </button>
            ))}
        </summary>
        {diff && <DiffViewer diff={diff} />}
        {/* Args + raw JSON result are redundant once the diff is rendered —
            the diff already shows the same information in a much more
            readable form. */}
        {!diff && args && Object.keys(args).length > 0 && (
          <pre className="gds-assistant__tool-call-args">
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
        {!needsApproval && result !== undefined && !diff && (
          <pre className="gds-assistant__tool-call-result">
            {typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)}
          </pre>
        )}
        {undo?.undone && undo.caveats?.length && undo.caveats.length > 0 && (
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
