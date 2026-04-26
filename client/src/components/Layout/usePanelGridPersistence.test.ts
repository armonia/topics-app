import { describe, test, expect } from "bun:test";
import { sanitizeRow } from "./usePanelGridPersistence";

describe("sanitizeRow", () => {
  test("accepts the simple legacy shape unchanged", () => {
    const out = sanitizeRow({
      itemKeys: ["standalone", "solo:t1"],
      widths: [0.6, 0.4],
    });
    expect(out!.itemKeys).toEqual(["standalone", "solo:t1"]);
    expect(out!.widths).toEqual([0.6, 0.4]);
    expect(out!.cellStacks).toBeUndefined();
  });

  test("preserves cellStacks when valid", () => {
    const out = sanitizeRow({
      itemKeys: ["standalone", "solo:t1"],
      widths: [0.5, 0.5],
      cellStacks: {
        standalone: { items: ["solo:t2"], heights: [0.6, 0.4] },
      },
    });
    expect(out!.cellStacks).toEqual({
      standalone: { items: ["solo:t2"], heights: [0.6, 0.4] },
    });
  });

  test("drops orphan cellStacks (primary not in itemKeys)", () => {
    const out = sanitizeRow({
      itemKeys: ["standalone"],
      widths: [1],
      cellStacks: {
        ghost: { items: ["solo:t2"], heights: [1, 1] },
      },
    });
    expect(out!.cellStacks).toBeUndefined();
  });

  test("returns null for non-object input", () => {
    expect(sanitizeRow(null)).toBeNull();
    expect(sanitizeRow(undefined)).toBeNull();
    expect(sanitizeRow("string")).toBeNull();
    expect(sanitizeRow(42)).toBeNull();
  });

  test("returns null when itemKeys missing", () => {
    expect(sanitizeRow({ widths: [1] })).toBeNull();
  });

  test("renormalizes widths when sum != 1", () => {
    const out = sanitizeRow({
      itemKeys: ["a", "b"],
      widths: [3, 1],
    });
    expect(out!.widths[0]).toBeCloseTo(0.75, 5);
    expect(out!.widths[1]).toBeCloseTo(0.25, 5);
  });

  test("renormalizes stack heights when sum != 1", () => {
    const out = sanitizeRow({
      itemKeys: ["a"],
      widths: [1],
      cellStacks: {
        a: { items: ["b"], heights: [2, 3] },
      },
    });
    const h = out!.cellStacks!.a.heights;
    expect(h[0]).toBeCloseTo(0.4, 5);
    expect(h[1]).toBeCloseTo(0.6, 5);
  });

  test("fills missing heights when array is shorter than items+1", () => {
    const out = sanitizeRow({
      itemKeys: ["a"],
      widths: [1],
      cellStacks: {
        a: { items: ["b", "c"], heights: [0.5] }, // only 1, need 3
      },
    });
    // After fill (1, 1, 1) and renormalize: each ~1/3. Wait — kept 0.5 + 1 + 1 = 2.5 → 0.2/0.4/0.4
    const h = out!.cellStacks!.a.heights;
    expect(h.length).toBe(3);
    expect(h.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5);
  });

  test("drops non-string itemKeys", () => {
    const out = sanitizeRow({
      itemKeys: ["a", 42, null, "b"],
      widths: [1, 1, 1, 1],
    });
    expect(out!.itemKeys).toEqual(["a", "b"]);
  });

  test("drops stacks with empty items array", () => {
    const out = sanitizeRow({
      itemKeys: ["a"],
      widths: [1],
      cellStacks: {
        a: { items: [], heights: [1] },
      },
    });
    expect(out!.cellStacks).toBeUndefined();
  });
});
