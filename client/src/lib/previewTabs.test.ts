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
