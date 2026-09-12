/**
 * Reading a persisted grid row back: a malformed or stale shape is rejected
 * rather than rendered, widths and stack heights are renormalized, and
 * deleting a space clears only that space's storage key.
 *
 * @covers LAYOUT-01
 */
import { describe, test, expect } from "bun:test";
import { sanitizeRow, panelGridStorageKey, clearPanelGridStorage } from "./usePanelGridPersistence";
import { DEFAULT_SPACE_ID } from "../../state/pane/types";

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

describe("clearPanelGridStorage (no localStorage leak on space delete)", () => {
  // Minimal in-memory localStorage shim (bun:test has no DOM). Save/restore any
  // pre-existing global so we don't perturb sibling tests.
  //
  // PUTTING BACK `undefined` IS NOT PUTTING IT BACK. Under bun there is no DOM,
  // so `prev` is undefined, and `globalThis.localStorage = prev` leaves the
  // PROPERTY in place holding undefined. Every later file that asks
  // `'localStorage' in globalThis` — the idiom two sibling files use to decide
  // whether to clean up after themselves — then reads "there was one already"
  // and keeps ITS fake. Measured on 2026-09-12: this file plus
  // `Project/projectSidebarHeights.test.ts` plus any file after them makes the
  // preload sentinel fire with `leaked DOM globals: localStorage`, and
  // `bun test client/src/components` goes red on a file that touches none of
  // this. Each of the three is green on its own, which is why
  // `check:test-globals` (one file at a time) never saw it.
  const withStorage = (fn: (store: Map<string, string>) => void) => {
    const store = new Map<string, string>();
    const had = 'localStorage' in globalThis;
    const prev = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
    try {
      fn(store);
    } finally {
      if (had) (globalThis as { localStorage?: unknown }).localStorage = prev;
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  };

  test("removes the deleted space's suffixed key", () => {
    withStorage((store) => {
      const spaceId = "space:doomed";
      store.set(panelGridStorageKey(spaceId), JSON.stringify({ gridRows: [] }));
      expect(store.has(panelGridStorageKey(spaceId))).toBe(true);
      clearPanelGridStorage(spaceId);
      expect(store.has(panelGridStorageKey(spaceId))).toBe(false);
    });
  });

  test("never touches the default space's legacy unsuffixed key", () => {
    withStorage((store) => {
      store.set("topics-panel-grid-layout", JSON.stringify({ gridRows: [] }));
      store.set(panelGridStorageKey(DEFAULT_SPACE_ID), JSON.stringify({ gridRows: [] }));
      clearPanelGridStorage(DEFAULT_SPACE_ID); // guarded no-op
      expect(store.has("topics-panel-grid-layout")).toBe(true);
      expect(store.has(panelGridStorageKey(DEFAULT_SPACE_ID))).toBe(true);
    });
  });
});
