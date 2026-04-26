import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import type { PaneState, ClosedPaneRecord } from "../types";
import { CLOSED_STACK_MAX } from "../types";

const blankState = (): PaneState => ({
  panes: {},
  groups: {},
  projects: {},
  closedStack: [],
  focusedPaneId: null,
  groupOrder: [],
  lastSeq: 0,
});

describe("paneReducer (PANE-01, PANE-03, PANE-04)", () => {
  test("OPEN_PANE adds a pane entity keyed by id", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: {
        id: "chat:t1",
        type: "chat",
        title: "Hello",
        topicId: "t1",
        groupId: "g1",
      },
    });
    expect(state.panes["chat:t1"]).toBeDefined();
    expect(state.panes["chat:t1"].type).toBe("chat");
  });

  test("CLOSE_PANE removes the pane entity and pushes a ClosedPaneRecord onto closedStack", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: {
        id: "chat:t1",
        type: "chat",
        title: "A",
        topicId: "t1",
        groupId: "g1",
      },
    });
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "g1", groupIndex: 0 },
    });
    expect(state.panes["chat:t1"]).toBeUndefined();
    expect(state.closedStack).toHaveLength(1);
    expect(state.closedStack[0].id).toBe("chat:t1");
  });

  test("UNDO_CLOSE re-inserts the pane at the original groupIndex with scroll offset and focus flag restored", () => {
    const state = blankState();
    state.groups["g1"] = {
      id: "g1",
      paneIds: ["a", "b", "c"],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.panes["a"] = {
      id: "a",
      type: "chat",
      title: "A",
      topicId: "ta",
    } as any;
    state.panes["b"] = {
      id: "b",
      type: "chat",
      title: "B",
      topicId: "tb",
    } as any;
    state.panes["c"] = {
      id: "c",
      type: "chat",
      title: "C",
      topicId: "tc",
    } as any;
    state.groupOrder = ["g1"];
    state.focusedPaneId = "b";

    // Close B
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "b", groupId: "g1", groupIndex: 1 },
    });
    expect(state.groups["g1"].paneIds).toEqual(["a", "c"]);
    expect(state.closedStack).toHaveLength(1);

    // Undo close
    paneReducer(state, { type: "UNDO_CLOSE" });
    expect(state.groups["g1"].paneIds).toEqual(["a", "b", "c"]); // exact position restored
    expect(state.focusedPaneId).toBe("b"); // focus restored (was focused at close)
    expect(state.closedStack).toHaveLength(0);
  });

  test("CLEAR_CLOSED_RECORD removes only the matching record, leaves others", () => {
    const state = blankState();
    const mkRecord = (id: string, seq: number): ClosedPaneRecord => ({
      id,
      closedAt: Date.now(),
      pane: { id, type: "chat", title: id },
      groupId: "g1",
      groupIndex: 0,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq,
    });
    state.closedStack = [mkRecord("a", 1), mkRecord("b", 2), mkRecord("c", 3)];

    paneReducer(state, {
      type: "CLEAR_CLOSED_RECORD",
      payload: { id: "b" },
    });

    expect(state.closedStack.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("CLEAR_CLOSED_RECORD with a non-matching id is a harmless no-op", () => {
    const state = blankState();
    const rec: ClosedPaneRecord = {
      id: "only",
      closedAt: Date.now(),
      pane: { id: "only", type: "chat", title: "Only" },
      groupId: "g1",
      groupIndex: 0,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 1,
    };
    state.closedStack = [rec];

    paneReducer(state, {
      type: "CLEAR_CLOSED_RECORD",
      payload: { id: "ghost" },
    });

    expect(state.closedStack).toHaveLength(1);
    expect(state.closedStack[0].id).toBe("only");
  });

  test("CLEAR_CLOSED_STACK empties the stack", () => {
    const state = blankState();
    state.closedStack = [
      {
        id: "a",
        closedAt: Date.now(),
        pane: { id: "a", type: "chat", title: "A" },
        groupId: "g1",
        groupIndex: 0,
        level: "app",
        focusedAtClose: false,
        tabOrderSnapshot: [],
        seq: 1,
      },
      {
        id: "b",
        closedAt: Date.now(),
        pane: { id: "b", type: "chat", title: "B" },
        groupId: "g1",
        groupIndex: 0,
        level: "app",
        focusedAtClose: false,
        tabOrderSnapshot: [],
        seq: 2,
      },
    ];

    paneReducer(state, { type: "CLEAR_CLOSED_STACK" });

    expect(state.closedStack).toHaveLength(0);
  });

  test("CLOSED_STACK_MAX bound is honored after CLEAR_CLOSED_RECORD (can re-fill to 50)", () => {
    const state = blankState();
    state.groups["g1"] = {
      id: "g1",
      paneIds: [],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.groupOrder = ["g1"];

    // Pre-fill the group so empty-group cleanup doesn't drop `g1` mid-loop.
    for (let i = 0; i < CLOSED_STACK_MAX; i++) {
      state.panes[`p${i}`] = {
        id: `p${i}`,
        type: "chat",
        title: `P${i}`,
      } as any;
      state.groups["g1"].paneIds.push(`p${i}`);
    }
    for (let i = 0; i < CLOSED_STACK_MAX; i++) {
      paneReducer(state, {
        type: "CLOSE_PANE",
        payload: { id: `p${i}`, groupId: "g1", groupIndex: i },
      });
    }
    expect(state.closedStack.length).toBe(CLOSED_STACK_MAX);

    // Clear one then close one more — the bound must still hold. The group
    // was pruned when emptied, so re-create it before re-using the id.
    paneReducer(state, {
      type: "CLEAR_CLOSED_RECORD",
      payload: { id: "p10" },
    });
    expect(state.closedStack.length).toBe(CLOSED_STACK_MAX - 1);

    state.groups["g1"] = {
      id: "g1",
      paneIds: [],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.panes["pNew"] = { id: "pNew", type: "chat", title: "N" } as any;
    state.groups["g1"].paneIds.push("pNew");
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "pNew", groupId: "g1", groupIndex: 0 },
    });
    expect(state.closedStack.length).toBe(CLOSED_STACK_MAX);

    // Clear the whole stack — subsequent closes still cap at MAX.
    paneReducer(state, { type: "CLEAR_CLOSED_STACK" });
    expect(state.closedStack.length).toBe(0);

    state.groups["g1"] = {
      id: "g1",
      paneIds: [],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    for (let i = 0; i < CLOSED_STACK_MAX + 5; i++) {
      const id = `q${i}`;
      state.panes[id] = { id, type: "chat", title: id } as any;
      state.groups["g1"].paneIds.push(id);
    }
    for (let i = 0; i < CLOSED_STACK_MAX + 5; i++) {
      paneReducer(state, {
        type: "CLOSE_PANE",
        payload: { id: `q${i}`, groupId: "g1", groupIndex: 0 },
      });
    }
    expect(state.closedStack.length).toBe(CLOSED_STACK_MAX);
  });

  test("lastSeq monotonicity: CLEAR_CLOSED_* advance the store's seq by 1 per dispatch", async () => {
    // The reducer itself doesn't bump lastSeq (the dispatcher does). To
    // exercise the full invariant we go through the store.
    const { usePaneStore } = await import("../store");
    usePaneStore.setState({
      panes: {},
      groups: {},
      projects: {},
      closedStack: [],
      focusedPaneId: null,
      groupOrder: [],
      lastSeq: 0,
    });

    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    usePaneStore.getState().dispatch({
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "g1", groupIndex: 0 },
    });
    const seqBeforeClear = usePaneStore.getState().lastSeq;

    usePaneStore.getState().dispatch({
      type: "CLEAR_CLOSED_RECORD",
      payload: { id: "chat:t1" },
    });
    expect(usePaneStore.getState().lastSeq).toBe(seqBeforeClear + 1);

    usePaneStore.getState().dispatch({ type: "CLEAR_CLOSED_STACK" });
    expect(usePaneStore.getState().lastSeq).toBe(seqBeforeClear + 2);
  });

  test("HYDRATE_FROM_SNAPSHOT clamps closedStack to CLOSED_STACK_MAX (defense-in-depth)", () => {
    const state = blankState();
    state.lastSeq = 0;

    // Build a 100-entry closedStack in valid sanitized shape so sanitizeSnapshot
    // passes it through (the sanitizer itself clamps, but this tests the
    // reducer's own defense-in-depth guard).
    const bigClosedStack: ClosedPaneRecord[] = Array.from({ length: 100 }, (_, i) => ({
      id: `closed-${i}`,
      closedAt: i * 1000,
      pane: { id: `chat:t${i}`, type: "chat" as const, title: `T${i}` },
      groupId: "g1",
      groupIndex: 0,
      level: "project" as const,
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: i,
    }));

    paneReducer(state, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          closedStack: bigClosedStack,
          lastSeq: 10,
          seq: 10,
        },
      },
    });

    expect(state.closedStack.length).toBeLessThanOrEqual(CLOSED_STACK_MAX);
  });

  test("CLOSE_PANE does NOT copy pane.scrollOffset onto the ClosedPaneRecord (device-local invariant)", () => {
    const state = blankState();
    state.groups["g1"] = {
      id: "g1",
      paneIds: ["a"],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.panes["a"] = {
      id: "a",
      type: "chat",
      title: "A",
      topicId: "ta",
      // Device-local — must not appear on the closed record or its nested pane.
      scrollOffset: 777,
    };
    state.groupOrder = ["g1"];

    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "a", groupId: "g1", groupIndex: 0 },
    });

    const rec = state.closedStack[0];
    expect(rec).toBeDefined();
    // Neither the outer record nor the nested pane may carry scrollOffset.
    expect(rec.scrollOffset).toBeUndefined();
    expect(rec.pane.scrollOffset).toBeUndefined();
  });

  test("UNDO_CLOSE does NOT restore scrollOffset onto the pane entity (cross-device safety)", () => {
    const state = blankState();
    state.groups["g1"] = {
      id: "g1",
      paneIds: ["a", "b"],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.panes["a"] = { id: "a", type: "chat", title: "A" };
    state.panes["b"] = { id: "b", type: "chat", title: "B" };
    state.groupOrder = ["g1"];

    // Simulate a cross-device/legacy record that still carries scrollOffset —
    // either the outer field or the nested pane field. UNDO_CLOSE must ignore
    // both so we don't leak device A's scroll position onto device B.
    const legacyRecord: ClosedPaneRecord = {
      id: "b",
      closedAt: Date.now(),
      pane: {
        id: "b",
        type: "chat",
        title: "B",
        scrollOffset: 999, // nested legacy value
      } as any,
      groupId: "g1",
      groupIndex: 1,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: ["a", "b"],
      scrollOffset: 1234, // outer legacy value
      seq: 1,
    };
    state.closedStack = [legacyRecord];
    // Remove `b` from the group to simulate the close that produced the record.
    state.groups["g1"].paneIds = ["a"];
    delete state.panes["b"];

    paneReducer(state, { type: "UNDO_CLOSE" });

    expect(state.panes["b"]).toBeDefined();
    // The reducer used to assign `pane.scrollOffset = record.scrollOffset`.
    // Post-fix it must leave scrollOffset unset so the device-local scroll
    // tracker can populate it fresh post-mount.
    expect(state.panes["b"].scrollOffset).toBeUndefined();
  });

  test("HYDRATE_FROM_SNAPSHOT leaves lastSeq at clean.lastSeq (no dispatcher double-bump)", async () => {
    // The reducer writes `state.lastSeq = clean.lastSeq` and the dispatcher
    // must NOT bump it again — otherwise the next WS broadcast carrying that
    // same server_seq is silently dropped by the LWW gate
    // (`clean.lastSeq <= state.lastSeq` fails at equal).
    const { usePaneStore } = await import("../store");
    usePaneStore.setState({
      panes: {},
      groups: {},
      projects: {},
      closedStack: [],
      focusedPaneId: null,
      groupOrder: [],
      lastSeq: 0,
    });

    const SERVER_SEQ = 42;
    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: {},
          groups: {},
          projects: {},
          closedStack: [],
          groupOrder: [],
          lastSeq: SERVER_SEQ,
          seq: SERVER_SEQ,
        },
      },
    });

    expect(usePaneStore.getState().lastSeq).toBe(SERVER_SEQ);

    // A subsequent local dispatch must bump above SERVER_SEQ so outbound
    // PUTs still carry a fresh seq (the `_seq` clamp + bump invariant).
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    expect(usePaneStore.getState().lastSeq).toBeGreaterThan(SERVER_SEQ);
  });

  test("closedStack bounded at 50 entries, FIFO eviction (PANE-03 / CONTEXT.md)", () => {
    const state = blankState();
    state.groups["g1"] = {
      id: "g1",
      paneIds: [],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.groupOrder = ["g1"];
    // Pre-fill panes; close in a separate loop so empty-group cleanup
    // doesn't prune `g1` after the first close.
    for (let i = 0; i < 55; i++) {
      state.panes[`p${i}`] = {
        id: `p${i}`,
        type: "chat",
        title: `P${i}`,
        topicId: `t${i}`,
      } as any;
      state.groups["g1"].paneIds.push(`p${i}`);
    }
    for (let i = 0; i < 55; i++) {
      paneReducer(state, {
        type: "CLOSE_PANE",
        payload: { id: `p${i}`, groupId: "g1", groupIndex: i },
      });
    }
    expect(state.closedStack.length).toBe(50);
    // Oldest 5 (p0..p4) were evicted
    expect(state.closedStack.find((r) => r.id === "p0")).toBeUndefined();
    expect(state.closedStack.find((r) => r.id === "p54")).toBeDefined();
  });
});

describe("paneReducer — audit fixes (empty-group cleanup, ratio clamp, reorder permutation)", () => {
  test("CLOSE_PANE prunes a non-default group when its last pane closes", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    expect(state.groups["g1"]).toBeDefined();
    expect(state.groupOrder).toContain("g1");
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "g1", groupIndex: 0 },
    });
    expect(state.groups["g1"]).toBeUndefined();
    expect(state.groupOrder).not.toContain("g1");
  });

  test("CLOSE_PANE keeps `group:default` even when emptied", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "group:default" },
    });
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "group:default", groupIndex: 0 },
    });
    expect(state.groups["group:default"]).toBeDefined();
    expect(state.groups["group:default"].paneIds).toEqual([]);
  });

  test("RESIZE clamps splitRatio to [0.05, 0.95] and rejects NaN", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p1", type: "chat", title: "A", groupId: "g1" },
    });
    state.groups["g1"].splitRatio = 0.5;

    paneReducer(state, { type: "RESIZE", payload: { groupId: "g1", ratio: 0 } });
    expect(state.groups["g1"].splitRatio).toBe(0.05);

    paneReducer(state, { type: "RESIZE", payload: { groupId: "g1", ratio: 1 } });
    expect(state.groups["g1"].splitRatio).toBe(0.95);

    paneReducer(state, { type: "RESIZE", payload: { groupId: "g1", ratio: NaN } });
    expect(state.groups["g1"].splitRatio).toBe(0.95); // unchanged

    paneReducer(state, { type: "RESIZE", payload: { groupId: "g1", ratio: 0.3 } });
    expect(state.groups["g1"].splitRatio).toBe(0.3);
  });

  test("REORDER_PANES drops orphan IDs and preserves the current member set", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p1", type: "chat", title: "A", groupId: "g1" },
    });
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p2", type: "chat", title: "B", groupId: "g1" },
    });
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p3", type: "chat", title: "C", groupId: "g1" },
    });

    // Adversarial payload: includes a non-existent id and drops p2.
    paneReducer(state, {
      type: "REORDER_PANES",
      payload: { groupId: "g1", paneIds: ["p3", "ghost-id", "p1"] },
    });

    // p3 and p1 reordered; ghost dropped; p2 appended at the end.
    expect(state.groups["g1"].paneIds).toEqual(["p3", "p1", "p2"]);
  });

  test("UNDO_CLOSE recreates the group after empty-group prune", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "g1", groupIndex: 0 },
    });
    expect(state.groups["g1"]).toBeUndefined();

    paneReducer(state, { type: "UNDO_CLOSE" });
    expect(state.groups["g1"]).toBeDefined();
    expect(state.groups["g1"].paneIds).toEqual(["chat:t1"]);
    expect(state.groupOrder).toContain("g1");
    expect(state.panes["chat:t1"]).toBeDefined();
  });

  test("REORDER_PANES with empty payload preserves all current members", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p1", type: "chat", title: "A", groupId: "g1" },
    });
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p2", type: "chat", title: "B", groupId: "g1" },
    });
    paneReducer(state, {
      type: "REORDER_PANES",
      payload: { groupId: "g1", paneIds: [] },
    });
    expect(state.groups["g1"].paneIds).toEqual(["p1", "p2"]);
  });

  test("REORDER_PANES rejects pane IDs from another group", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p1", type: "chat", title: "A", groupId: "g1" },
    });
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "p2", type: "chat", title: "B", groupId: "g2" },
    });

    // Payload tries to inject p2 (lives in g2) into g1.
    paneReducer(state, {
      type: "REORDER_PANES",
      payload: { groupId: "g1", paneIds: ["p2", "p1"] },
    });

    expect(state.groups["g1"].paneIds).toEqual(["p1"]);
    expect(state.groups["g2"].paneIds).toEqual(["p2"]);
  });
});
