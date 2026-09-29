/**
 * The keys of a split's children follow what each child CARRIES, so a row that
 * moves, loses its first column or has a row inserted above it keeps its key,
 * and React moves its subtree instead of rebuilding every pane in it.
 *
 * @covers SPLITPERF-01
 */
import { describe, expect, it } from "bun:test";
import { assignSplitKeys, EMPTY_SPLIT_KEYS } from "./splitKeys";
import { leaf, type LayoutNode, type SplitChild } from "../../state/layout/layoutTree";

const row = (...ids: string[]): SplitChild => ({
  weight: 1,
  node: { kind: "split", dir: "row", children: ids.map((id) => ({ weight: 1, node: leaf(id) as LayoutNode })) },
});
const cell = (id: string): SplitChild => ({ weight: 1, node: leaf(id) });

describe("assignSplitKeys", () => {
  it("keys a leaf on its id", () => {
    expect(assignSplitKeys(EMPTY_SPLIT_KEYS, [cell("a"), cell("b")]).keys).toEqual(["leaf:a", "leaf:b"]);
  });

  it("keeps a row's key when a row is inserted ABOVE it", () => {
    const first = assignSplitKeys(EMPTY_SPLIT_KEYS, [row("a", "b")]);
    const next = assignSplitKeys(first, [row("c"), row("a", "b")]);
    expect(next.keys[1]).toBe(first.keys[0]);
    expect(next.keys[0]).not.toBe(first.keys[0]);
  });

  it("keeps both keys when two rows swap", () => {
    const first = assignSplitKeys(EMPTY_SPLIT_KEYS, [row("a"), row("b", "c")]);
    const next = assignSplitKeys(first, [row("b", "c"), row("a")]);
    expect(next.keys).toEqual([first.keys[1], first.keys[0]]);
  });

  it("keeps a row's key when its FIRST column closes", () => {
    const first = assignSplitKeys(EMPTY_SPLIT_KEYS, [row("a", "b"), row("c")]);
    const next = assignSplitKeys(first, [row("b"), row("c")]);
    expect(next.keys).toEqual(first.keys);
  });

  it("gives the same row the same key when nothing changed", () => {
    const first = assignSplitKeys(EMPTY_SPLIT_KEYS, [row("a"), row("b")]);
    expect(assignSplitKeys(first, [row("a"), row("b")]).keys).toEqual(first.keys);
  });

  it("never hands out one key twice, even when a new row starts with a leaf an old key was named after", () => {
    const first = assignSplitKeys(EMPTY_SPLIT_KEYS, [row("a", "b")]);
    // `a` leaves for a row of its own; the old row (now just `b`) keeps its key,
    // and the new row cannot be named `split:a` a second time.
    const next = assignSplitKeys(first, [row("a"), row("b")]);
    expect(new Set(next.keys).size).toBe(2);
    expect(next.keys).toContain(first.keys[0]);
  });

  it("does not tie two rows together through positional placeholders", () => {
    const first = assignSplitKeys(EMPTY_SPLIT_KEYS, [row("__skip:0:empty"), row("a")]);
    const next = assignSplitKeys(first, [row("a"), row("__skip:1:empty")]);
    expect(next.keys[0]).toBe(first.keys[1]);
    expect(new Set(next.keys).size).toBe(2);
  });
});
