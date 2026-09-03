/**
 * Preview tabs: the markers that survive a restore, and the replace primitive
 * that swaps one preview for the next instead of stacking them.
 *
 * @covers TAB-SYNC-03
 */
import { describe, test, expect } from "bun:test";
import {
  markTabRestored,
  consumeTabRestored,
  findPreviewInList,
  replaceInList,
  restoreSlot,
  insertAtRestoreSlot,
} from "./previewTabs";

describe("restore markers (markTabRestored / consumeTabRestored)", () => {
  test("consume returns true exactly once after a mark (one-shot)", () => {
    markTabRestored("chat:t1");
    expect(consumeTabRestored("chat:t1")).toBe(true);
    // Second consume of the same id is false — the marker is one-shot so it can
    // never leak into a later, genuine navigation.
    expect(consumeTabRestored("chat:t1")).toBe(false);
  });

  test("consume returns false for an id that was never marked", () => {
    expect(consumeTabRestored("chat:never")).toBe(false);
  });

  test("marks are independent across ids", () => {
    markTabRestored("a");
    markTabRestored("b");
    expect(consumeTabRestored("b")).toBe(true);
    expect(consumeTabRestored("a")).toBe(true);
    expect(consumeTabRestored("a")).toBe(false);
  });
});

describe("preview-replace primitives still behave (regression)", () => {
  test("findPreviewInList returns the first unpinned id, excluding the new one", () => {
    expect(findPreviewInList(["a", "b"], new Set<string>(), "b")).toBe("a");
    expect(findPreviewInList(["a", "b"], new Set(["a"]), "b")).toBeNull(); // a pinned, b excluded
  });

  test("replaceInList swaps the target id in place", () => {
    expect(replaceInList(["a", "b", "c"], "b", "x")).toEqual(["a", "x", "c"]);
    expect(replaceInList(["a"], "missing", "x")).toEqual(["a", "x"]); // append when absent
  });
});

describe("restore slot (the reopened tab goes back where it was)", () => {
  test("the recorded index wins over the end of the list", () => {
    expect(restoreSlot(1, 2)).toBe(1);
    expect(restoreSlot(0, 3)).toBe(0);
  });

  test("an index past the current end means last, never out of range", () => {
    // The bar shrank while the tab was closed: index 5 in a 2-tab bar is 2.
    expect(restoreSlot(5, 2)).toBe(2);
    expect(restoreSlot(-1, 2)).toBe(0);
    expect(restoreSlot(undefined, 2)).toBe(2);
  });

  test("insert puts the middle tab back in the middle", () => {
    expect(insertAtRestoreSlot(["a", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(insertAtRestoreSlot(["b", "c"], "a", 0)).toEqual(["a", "b", "c"]);
    expect(insertAtRestoreSlot(["a", "b"], "c", 2)).toEqual(["a", "b", "c"]);
  });

  test("a list that already holds the id comes back by reference", () => {
    const list = ["a", "b"];
    // Identity, not equality: a fresh array with the same contents is still a
    // state change for React and would re-run the store sync for nothing.
    expect(insertAtRestoreSlot(list, "b", 1)).toBe(list);
  });
});
