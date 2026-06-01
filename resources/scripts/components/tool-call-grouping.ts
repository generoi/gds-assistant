/**
 * Tool-call grouping for the chat thread (#35).
 *
 * Bulk operations — a `gds/content-update` run of 12 menu_order edits, a
 * `gds/forms-get` audit across 20 forms — produce a wall of identical
 * tool-call cards. This helper folds runs of *adjacent* same-shape calls
 * inside one assistant message into a single `ToolCallGroup` that the
 * renderer can show as `▶ gds/content-update × 12 [Done]` with the
 * individual calls available under an expander.
 *
 * Grouping rules:
 *   - Same `toolName`
 *   - Same SET of arg keys (so `update {title}` and `update {menu_order}`
 *     don't group; values are free to differ)
 *   - Same status bucket (running / done / error / pending-approval) so a
 *     pending-approval row at the end doesn't get folded into the
 *     completed-Done card above it
 *   - Adjacent in the parts array (a non-tool-call part breaks the run)
 *   - Minimum group size: 3 (so two of-a-kind stay solo)
 *
 * Per-call state (error, undoable, diff) is preserved on each
 * `ToolCallGroupCall` entry — the renderer hands each one to
 * `ToolCallFallback` when the user expands the row.
 */

import type { UiContentPart, UiToolCallPart } from "../types/runtime";

/** Status bucket; calls with different buckets never group. */
export type ToolCallStatus = "running" | "done" | "error" | "pending-approval";

/** A single call inside a {@link ToolCallGroup}. Mirrors `UiToolCallPart`. */
export type ToolCallGroupCall = UiToolCallPart;

/** Synthetic "tool-call-group" part the renderer sees alongside real parts. */
export interface ToolCallGroup {
  type: "tool-call-group";
  /** `namespace/slug` — same as the underlying tool calls' `toolName`. */
  toolName: string;
  /** Status bucket the group inherits from its members (all share one). */
  status: ToolCallStatus;
  /** The sorted arg-key fingerprint that gates membership. */
  argsShape: string;
  /** The individual calls — caller can still render each in full. */
  calls: ToolCallGroupCall[];
}

/** Item the renderer ultimately iterates over: a real part or a group. */
export type GroupedPart = UiContentPart | ToolCallGroup;

interface GroupOptions {
  /**
   * Minimum number of like calls before they collapse. Defaults to 3 so a
   * pair of related ops stays uncollapsed (the spec calls this out — two
   * of a kind isn't enough noise to warrant hiding either).
   */
  minGroupSize?: number;
  /**
   * Tool-call ids the modal is currently waiting on for user approval.
   * A call's bucket flips to `pending-approval` when its id is in this
   * set, so the approval cards stay visible rather than folding into the
   * `Done` group above.
   */
  pendingApprovalIds?: ReadonlySet<string>;
}

/**
 * Sort-stable JSON key list — fingerprints the "shape" of the args object.
 * @param args
 */
function argKeysFingerprint(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  return Object.keys(args).sort().join("|");
}

/**
 * Bucket a tool-call into one of the four statuses.
 * @param call
 * @param pendingApprovalIds
 */
function bucket(
  call: UiToolCallPart,
  pendingApprovalIds: ReadonlySet<string> | undefined,
): ToolCallStatus {
  if (
    pendingApprovalIds &&
    call.toolCallId &&
    pendingApprovalIds.has(call.toolCallId)
  ) {
    return "pending-approval";
  }
  if (call.result === undefined) {
    return "running";
  }
  return call.isError ? "error" : "done";
}

/**
 * Walk an assistant message's content parts and fold adjacent tool-calls
 * that share `{toolName, argKeys, status}` into `ToolCallGroup`s. Parts
 * that don't qualify pass through untouched, preserving order.
 * @param parts
 * @param opts
 */
export function groupAdjacentToolCalls(
  parts: ReadonlyArray<UiContentPart>,
  opts: GroupOptions = {},
): GroupedPart[] {
  const minGroupSize = Math.max(2, opts.minGroupSize ?? 3);
  const pending = opts.pendingApprovalIds;
  const out: GroupedPart[] = [];

  let run: ToolCallGroupCall[] = [];
  let runKey: string | null = null;

  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    if (run.length >= minGroupSize) {
      const first = run[0]!;
      out.push({
        type: "tool-call-group",
        toolName: first.toolName,
        status: bucket(first, pending),
        argsShape: argKeysFingerprint(first.args),
        calls: run,
      });
    } else {
      // Below threshold — spill each call back into the stream so it
      // renders as a standalone card.
      out.push(...run);
    }
    run = [];
    runKey = null;
  };

  for (const part of parts) {
    if (part.type !== "tool-call") {
      flushRun();
      out.push(part);
      continue;
    }

    const key = [
      part.toolName,
      argKeysFingerprint(part.args),
      bucket(part, pending),
    ].join("\0");

    if (runKey === null || runKey === key) {
      run.push(part);
      runKey = key;
    } else {
      flushRun();
      run.push(part);
      runKey = key;
    }
  }

  flushRun();
  return out;
}
