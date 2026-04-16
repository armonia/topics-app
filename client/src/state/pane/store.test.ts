import { describe, test, expect, beforeEach } from "bun:test";
import { usePaneStore } from "./store";

// Reset the singleton store between tests — it's a module-level Zustand
// instance, so its state leaks across assertions without an explicit reset.
function resetStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    projects: {},
    closedStack: [],
    focusedPaneId: null,
    groupOrder: [],
    lastSeq: 0,
  });
}

describe("usePaneStore.setPaneScrollOffset (PANE-03 device-local setter)", () => {
  beforeEach(resetStore);

  test("writes scrollOffset onto the pane entity", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    const seqBefore = usePaneStore.getState().lastSeq;

    usePaneStore.getState().setPaneScrollOffset("chat:t1", 250);

    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBe(250);
    // Device-local write must NOT bump lastSeq — otherwise syncServer fires
    // on every scroll tick (review I1 invariant).
    expect(usePaneStore.getState().lastSeq).toBe(seqBefore);
  });

  test("rejects negative and non-finite offsets without touching state", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });

    usePaneStore.getState().setPaneScrollOffset("chat:t1", -5);
    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBeUndefined();

    usePaneStore.getState().setPaneScrollOffset("chat:t1", NaN);
    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBeUndefined();

    usePaneStore.getState().setPaneScrollOffset("chat:t1", Infinity);
    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBeUndefined();
  });

  test("no-ops when the pane id does not exist", () => {
    const before = { ...usePaneStore.getState().panes };
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 100);
    expect(usePaneStore.getState().panes).toEqual(before);
  });

  test("repeated calls for a missing paneId stay idempotent (dev warn dedupe)", () => {
    // Review I2 (round-7): a throttled scroll handler at 250 ms during a
    // racy mount fires setPaneScrollOffset before OPEN_PANE. The previous
    // implementation warned on every call; now the warn is deduped by
    // paneId. We can't reliably stub console in bun:test across versions,
    // so assert the observable behavior: state stays clean across N calls.
    const seqBefore = usePaneStore.getState().lastSeq;
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 100);
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 200);
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 300);

    expect(usePaneStore.getState().panes["chat:ghost"]).toBeUndefined();
    // Device-local setter must never bump lastSeq — even on a missing id.
    expect(usePaneStore.getState().lastSeq).toBe(seqBefore);
  });
});

describe("usePaneStore.dispatch (lastSeq monotonicity)", () => {
  beforeEach(resetStore);

  test("each dispatch advances lastSeq by exactly 1 after CLOSE_PANE fix", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    const afterOpen = usePaneStore.getState().lastSeq;

    usePaneStore.getState().dispatch({
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "g1", groupIndex: 0 },
    });
    const afterClose = usePaneStore.getState().lastSeq;

    // Without the review-round-2 I3 fix, close bumped lastSeq twice
    // (reducer + dispatcher). After the fix, it advances by exactly one.
    expect(afterClose).toBe(afterOpen + 1);
    // The ClosedPaneRecord seq should match the new lastSeq.
    const rec = usePaneStore.getState().closedStack[0];
    expect(rec.seq).toBe(afterClose);
  });
});
