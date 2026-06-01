/**
 * Unit tests for the line + word LCS diff helpers powering the chat's
 * tool-call diff card. Pure functions — no DOM, no WP globals.
 */

import {
  diffLines,
  diffWords,
  collapseUnchanged,
  pairModifiedLines,
  type DiffSegment,
  type ModifiedLine,
} from "../diff";

describe("diffLines", () => {
  test("empty inputs produce empty output", () => {
    expect(diffLines("", "")).toEqual([{ type: "eq", text: "" }]);
  });

  test("identical input is all eq segments", () => {
    const out = diffLines("a\nb\nc", "a\nb\nc");
    expect(out).toEqual([
      { type: "eq", text: "a" },
      { type: "eq", text: "b" },
      { type: "eq", text: "c" },
    ]);
  });

  test("pure insertion only emits add segments after the prefix", () => {
    const out = diffLines("a\nb", "a\nb\nc");
    expect(out).toEqual([
      { type: "eq", text: "a" },
      { type: "eq", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  test("pure deletion only emits del segments", () => {
    const out = diffLines("a\nb\nc", "a\nb");
    expect(out).toEqual([
      { type: "eq", text: "a" },
      { type: "eq", text: "b" },
      { type: "del", text: "c" },
    ]);
  });

  test("substitution emits del + add for the changed lines", () => {
    const out = diffLines("a\nx\nc", "a\ny\nc");
    expect(out).toEqual([
      { type: "eq", text: "a" },
      { type: "del", text: "x" },
      { type: "add", text: "y" },
      { type: "eq", text: "c" },
    ]);
  });

  test("handles non-string inputs by coercion", () => {
    // The function uses `String(... ?? '')` so null/undefined become empty.
    expect(diffLines(null, undefined)).toEqual([{ type: "eq", text: "" }]);
  });

  test("long shared suffix is preserved after a diverging head", () => {
    const out = diffLines("x\na\nb\nc", "y\na\nb\nc");
    expect(out.filter((s) => s.type === "eq").map((s) => s.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("diffWords", () => {
  test("word-level diff inside a single line", () => {
    const out = diffWords("the quick brown fox", "the slow brown fox");
    const types = out.map((t) => t.type);
    expect(types).toContain("del");
    expect(types).toContain("add");
    // unchanged words stay as eq
    const eqTexts = out.filter((t) => t.type === "eq").map((t) => t.text);
    expect(eqTexts).toEqual(expect.arrayContaining(["the", "brown", "fox"]));
  });

  test("whitespace tokens are preserved as their own segments", () => {
    const out = diffWords("a b", "a b");
    // tokenizer splits on /\S+|\s+/ so spaces are separate tokens.
    expect(out.filter((t) => t.type === "eq").length).toBe(3);
  });

  test("identical input is all eq tokens", () => {
    const out = diffWords("hello world", "hello world");
    expect(out.every((t) => t.type === "eq")).toBe(true);
  });
});

describe("collapseUnchanged", () => {
  test("a pure-equal diff is returned as-is (no hunks to collapse around)", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    const collapsed = collapseUnchanged(lines, 2);
    expect(collapsed).toEqual(lines);
  });

  test("long run of eq lines between two hunks collapses to a gap segment", () => {
    // 10 equal lines sandwiched between a deletion and an addition.
    const before =
      "x\n" + Array.from({ length: 10 }, (_, i) => `eq${i}`).join("\n");
    const after =
      Array.from({ length: 10 }, (_, i) => `eq${i}`).join("\n") + "\ny";
    const lines = diffLines(before, after);
    const out = collapseUnchanged(lines, 2);
    expect(out.some((s) => s.type === "gap")).toBe(true);
    // first 2 eq lines (head) + gap + last 2 eq lines (tail) are kept
    const eqCount = out.filter((s) => s.type === "eq").length;
    expect(eqCount).toBe(4);
  });

  test("short runs of unchanged lines are not collapsed", () => {
    const lines = diffLines("x\na\ny", "z\na\nw");
    const out = collapseUnchanged(lines, 2);
    expect(out.some((s) => s.type === "gap")).toBe(false);
  });
});

describe("pairModifiedLines", () => {
  test("one del followed by one add pairs into a mod", () => {
    const segs: DiffSegment[] = [
      { type: "eq", text: "a" },
      { type: "del", text: "old" },
      { type: "add", text: "new" },
      { type: "eq", text: "b" },
    ];
    const paired = pairModifiedLines(segs);
    expect(paired.filter((r) => r.type === "mod")).toHaveLength(1);
    const mod = paired.find((r): r is ModifiedLine => r.type === "mod")!;
    expect(mod.del).toBe("old");
    expect(mod.add).toBe("new");
    expect(Array.isArray(mod.words)).toBe(true);
  });

  test("uneven counts: extra del stays solo, extra add stays solo", () => {
    const segs: DiffSegment[] = [
      { type: "del", text: "d1" },
      { type: "del", text: "d2" },
      { type: "add", text: "a1" },
    ];
    const paired = pairModifiedLines(segs);
    const mods = paired.filter((r) => r.type === "mod");
    const dels = paired.filter((r): r is DiffSegment => r.type === "del");
    expect(mods).toHaveLength(1);
    expect(dels).toHaveLength(1);
    expect(dels[0]!.text).toBe("d2");
  });

  test("eq + gap segments pass through untouched", () => {
    const segs: DiffSegment[] = [
      { type: "eq", text: "context" },
      { type: "gap", text: "… 5 unchanged lines" },
      { type: "add", text: "new" },
    ];
    const paired = pairModifiedLines(segs);
    expect(paired.map((r) => r.type)).toEqual(["eq", "gap", "add"]);
  });
});

describe("end-to-end shape: lines → collapse → pair", () => {
  test("a small substitution turns into a mod row with inline word diff", () => {
    const lines = diffLines('{\n  "title": "old"\n}', '{\n  "title": "new"\n}');
    const collapsed = collapseUnchanged(lines, 2);
    const paired = pairModifiedLines(collapsed);
    // Expect: eq `{`, mod (old/new title line), eq `}`
    const mods = paired.filter((r): r is ModifiedLine => r.type === "mod");
    expect(mods).toHaveLength(1);
    // Inline word diff should mark the "old"/"new" tokens differently
    const words = mods[0]!.words;
    const addedTexts = words.filter((w) => w.type === "add").map((w) => w.text);
    const delTexts = words.filter((w) => w.type === "del").map((w) => w.text);
    expect(delTexts.join("")).toContain("old");
    expect(addedTexts.join("")).toContain("new");
  });
});
