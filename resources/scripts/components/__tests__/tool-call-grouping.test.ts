/**
 * Tests for the tool-call grouping logic (#35). Pure function — no DOM,
 * no assistant-ui runtime, no React. Each test asserts one rule of the
 * grouping spec.
 */

import { groupAdjacentToolCalls } from "../tool-call-grouping";
import type { UiContentPart, UiToolCallPart } from "../../types/runtime";

function call(
  toolName: string,
  args: Record<string, unknown> | undefined,
  opts: Partial<UiToolCallPart> = {},
): UiToolCallPart {
  return {
    type: "tool-call",
    toolCallId: opts.toolCallId ?? Math.random().toString(36).slice(2),
    toolName,
    args: args ?? {},
    result: opts.result,
    isError: opts.isError,
  };
}

const text = (t: string): UiContentPart => ({ type: "text", text: t });

describe("groupAdjacentToolCalls", () => {
  test("fewer than minGroupSize identical calls stay solo", () => {
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1 }, { result: {} }),
      call("gds/posts-update", { id: 2 }, { result: {} }),
    ];
    const out = groupAdjacentToolCalls(parts);
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.type === "tool-call")).toBe(true);
  });

  test("three or more same-shape calls collapse into a group", () => {
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1, menu_order: 1 }, { result: {} }),
      call("gds/posts-update", { id: 2, menu_order: 2 }, { result: {} }),
      call("gds/posts-update", { id: 3, menu_order: 3 }, { result: {} }),
    ];
    const out = groupAdjacentToolCalls(parts);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("tool-call-group");
    if (out[0]!.type === "tool-call-group") {
      expect(out[0]!.calls).toHaveLength(3);
      expect(out[0]!.toolName).toBe("gds/posts-update");
      expect(out[0]!.status).toBe("done");
    }
  });

  test("different arg-key shapes don't group even with same tool name", () => {
    // {id, title} and {id, menu_order} have different arg shapes — the
    // spec is explicit: same SET of keys, not just same toolName.
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1, title: "a" }, { result: {} }),
      call("gds/posts-update", { id: 2, title: "b" }, { result: {} }),
      call("gds/posts-update", { id: 3, menu_order: 3 }, { result: {} }),
    ];
    const out = groupAdjacentToolCalls(parts);
    // Neither run reaches the min size of 3 on its own.
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.type === "tool-call")).toBe(true);
  });

  test("non-tool part between calls breaks the group", () => {
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1 }, { result: {} }),
      call("gds/posts-update", { id: 2 }, { result: {} }),
      text("Interjected note."),
      call("gds/posts-update", { id: 3 }, { result: {} }),
    ];
    const out = groupAdjacentToolCalls(parts);
    // Two two-call runs flanking a text part — neither reaches the
    // 3-call minimum, so everything stays solo.
    expect(out.filter((p) => p.type === "tool-call-group")).toHaveLength(0);
    expect(out.map((p) => p.type)).toEqual([
      "tool-call",
      "tool-call",
      "text",
      "tool-call",
    ]);
  });

  test("mixed status splits into separate groups (pending sinks to its own bucket)", () => {
    // 3 done + 3 pending-approval should split into two groups so the
    // approval cards stay visible rather than folding under "Done".
    const parts: UiContentPart[] = [
      call("gds/terms-delete", { id: 1 }, { result: { ok: true } }),
      call("gds/terms-delete", { id: 2 }, { result: { ok: true } }),
      call("gds/terms-delete", { id: 3 }, { result: { ok: true } }),
      call("gds/terms-delete", { id: 4, toolCallId: "p1" } as never, {
        toolCallId: "p1",
      }),
      call("gds/terms-delete", { id: 5, toolCallId: "p2" } as never, {
        toolCallId: "p2",
      }),
      call("gds/terms-delete", { id: 6, toolCallId: "p3" } as never, {
        toolCallId: "p3",
      }),
    ];
    const out = groupAdjacentToolCalls(parts, {
      pendingApprovalIds: new Set(["p1", "p2", "p3"]),
    });
    const groups = out.filter((p) => p.type === "tool-call-group");
    expect(groups).toHaveLength(2);
    if (groups[0]!.type === "tool-call-group") {
      expect(groups[0]!.status).toBe("done");
      expect(groups[0]!.calls).toHaveLength(3);
    }
    if (groups[1]!.type === "tool-call-group") {
      expect(groups[1]!.status).toBe("pending-approval");
      expect(groups[1]!.calls).toHaveLength(3);
    }
  });

  test("an errored call mid-run splits the group on its boundary", () => {
    // Status changes break runs — a successful run, an error in the
    // middle, then another success can produce two separate groups.
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1 }, { result: {} }),
      call("gds/posts-update", { id: 2 }, { result: {} }),
      call("gds/posts-update", { id: 3 }, { result: {} }),
      call(
        "gds/posts-update",
        { id: 4 },
        { result: { error: "oops" }, isError: true },
      ),
      call("gds/posts-update", { id: 5 }, { result: {} }),
      call("gds/posts-update", { id: 6 }, { result: {} }),
      call("gds/posts-update", { id: 7 }, { result: {} }),
    ];
    const out = groupAdjacentToolCalls(parts);
    const groups = out.filter((p) => p.type === "tool-call-group");
    expect(groups).toHaveLength(2);
    // The lone error call between them stays solo (below min size).
    expect(out.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });

  test("a running call shouldn't group with completed ones", () => {
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1 }, { result: {} }),
      call("gds/posts-update", { id: 2 }, { result: {} }),
      call("gds/posts-update", { id: 3 }, { result: {} }),
      call("gds/posts-update", { id: 4 }), // running — result undefined
    ];
    const out = groupAdjacentToolCalls(parts);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe("tool-call-group");
    expect(out[1]!.type).toBe("tool-call");
  });

  test("custom minGroupSize is respected", () => {
    const parts: UiContentPart[] = [
      call("gds/posts-update", { id: 1 }, { result: {} }),
      call("gds/posts-update", { id: 2 }, { result: {} }),
    ];
    const out = groupAdjacentToolCalls(parts, { minGroupSize: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("tool-call-group");
  });

  test("empty input returns empty output", () => {
    expect(groupAdjacentToolCalls([])).toEqual([]);
  });

  test("text-only message passes through unchanged", () => {
    const parts: UiContentPart[] = [text("Hello"), text("World")];
    const out = groupAdjacentToolCalls(parts);
    expect(out).toEqual(parts);
  });
});
