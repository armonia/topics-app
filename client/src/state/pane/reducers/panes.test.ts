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
  lastServerSeq: 0,
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
    };
    state.panes["b"] = {
      id: "b",
      type: "chat",
      title: "B",
      topicId: "tb",
    };
    state.panes["c"] = {
      id: "c",
      type: "chat",
      title: "C",
      topicId: "tc",
    };
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
      };
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
    state.panes["pNew"] = { id: "pNew", type: "chat", title: "N" };
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
      state.panes[id] = { id, type: "chat", title: id };
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
      },
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
    // The reducer writes `state.lastSeq = max(state.lastSeq, clean.lastSeq)`
    // and the dispatcher must NOT bump it again — otherwise the next WS
    // broadcast carrying that same server_seq is silently dropped by the LWW
    // gate (`clean.server_seq <= state.lastServerSeq` fails at equal).
    const { usePaneStore } = await import("../store");
    usePaneStore.setState({
      panes: {},
      groups: {},
      projects: {},
      closedStack: [],
      focusedPaneId: null,
      groupOrder: [],
      lastSeq: 0,
      lastServerSeq: 0,
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
          server_seq: SERVER_SEQ,
          seq: SERVER_SEQ,
        },
      },
    });

    expect(usePaneStore.getState().lastSeq).toBe(SERVER_SEQ);
    expect(usePaneStore.getState().lastServerSeq).toBe(SERVER_SEQ);

    // A subsequent local dispatch must bump above SERVER_SEQ so outbound
    // PUTs still carry a fresh seq (the `_seq` clamp + bump invariant).
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    expect(usePaneStore.getState().lastSeq).toBeGreaterThan(SERVER_SEQ);
  });

  test("LWW gate: local dispatch bursts do not block newer remote frames (audit HIGH)", async () => {
    // Scenario from the audit: A and B hydrated at server_seq=100. On A the
    // user clicks around (device-local FOCUS_PANE dispatches inflate the
    // LOCAL counter); on B a structural change PUTs and the server broadcasts
    // server_seq=101. Under the old gate (clean.lastSeq <= state.lastSeq) A
    // dropped that frame — a focus click on one device cancelled a structural
    // edit on another. The gate must compare server seq vs server seq.
    const { usePaneStore } = await import("../store");
    usePaneStore.setState({
      panes: {},
      groups: {},
      projects: {},
      closedStack: [],
      focusedPaneId: null,
      groupOrder: [],
      lastSeq: 0,
      lastServerSeq: 0,
    });

    // Hydrate at server_seq=100.
    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: {},
          groups: {},
          closedStack: [],
          groupOrder: [],
          lastSeq: 100,
          server_seq: 100,
          seq: 100,
        },
      },
    });
    expect(usePaneStore.getState().lastServerSeq).toBe(100);

    // Burst of device-local dispatches — lastSeq runs ahead of 101.
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:x", type: "chat", title: "X", groupId: "g1" },
    });
    for (let i = 0; i < 5; i++) {
      usePaneStore.getState().dispatch({ type: "FOCUS_PANE", payload: { id: "chat:x" } });
    }
    expect(usePaneStore.getState().lastSeq).toBeGreaterThan(101);

    // Remote structural change at server_seq=101 MUST still apply.
    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: { "chat:remote": { id: "chat:remote", type: "chat", title: "R" } },
          groups: { g9: { id: "g9", paneIds: ["chat:remote"], splitRatio: 0.5, splitAxis: "horizontal" } },
          closedStack: [],
          groupOrder: ["g9"],
          lastSeq: 101,
          server_seq: 101,
          seq: 101,
        },
      },
    });

    expect(usePaneStore.getState().lastServerSeq).toBe(101);
    expect(usePaneStore.getState().panes["chat:remote"]).toBeDefined();
    // The local counter never regresses (outbound PUT freshness invariant).
    expect(usePaneStore.getState().lastSeq).toBeGreaterThan(101);
  });

  test("LWW gate: warm-boot snapshot with server_seq 0 applies on an empty store, not mid-session", async () => {
    const { usePaneStore } = await import("../store");
    usePaneStore.setState({
      panes: {},
      groups: {},
      projects: {},
      closedStack: [],
      focusedPaneId: null,
      groupOrder: [],
      lastSeq: 0,
      lastServerSeq: 0,
    });

    // Boot-time localStorage hydrate from a never-synced device: server_seq 0
    // on an EMPTY store → warm-boot escape lets it through.
    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: { "chat:warm": { id: "chat:warm", type: "chat", title: "W" } },
          groups: { g1: { id: "g1", paneIds: ["chat:warm"], splitRatio: 0.5, splitAxis: "horizontal" } },
          closedStack: [],
          groupOrder: ["g1"],
          lastSeq: 7,
          server_seq: 0,
          seq: 0,
        },
      },
    });
    expect(usePaneStore.getState().panes["chat:warm"]).toBeDefined();

    // Mid-session (store non-empty), another 0-stamped snapshot must NOT
    // clobber state.
    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: {},
          groups: {},
          closedStack: [],
          groupOrder: [],
          lastSeq: 8,
          server_seq: 0,
          seq: 0,
        },
      },
    });
    expect(usePaneStore.getState().panes["chat:warm"]).toBeDefined();
  });

  test("LWW gate: snapshot without server_seq is dropped", async () => {
    const { usePaneStore } = await import("../store");
    usePaneStore.setState({
      panes: { "chat:keep": { id: "chat:keep", type: "chat", title: "K" } },
      groups: {},
      projects: {},
      closedStack: [],
      focusedPaneId: null,
      groupOrder: [],
      lastSeq: 10,
      lastServerSeq: 5,
    });

    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: {},
          groups: {},
          closedStack: [],
          groupOrder: [],
          lastSeq: 999,
          seq: 999,
        },
      },
    });
    // No server_seq → no LWW key → frame dropped, local state intact.
    expect(usePaneStore.getState().panes["chat:keep"]).toBeDefined();
    expect(usePaneStore.getState().lastServerSeq).toBe(5);
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
      };
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

  // -------------------------------------------------------------------------
  // PURGE_ORPHAN_PANE — post-mortem from May-3 sidebar-flash incident.
  // Effect 7 in usePanelLifecycle dispatches this when it detects a topic
  // id with `projectPath` set that was opened as a standalone pane. Differs
  // from CLOSE_PANE: no closedStack push (UNDO would re-create the orphan).
  // -------------------------------------------------------------------------

  test("PURGE_ORPHAN_PANE removes the pane and does NOT push to closedStack", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "topic-orphan", type: "chat", topicId: "t1", groupId: "g1" },
    });
    expect(state.panes["topic-orphan"]).toBeDefined();
    expect(state.groups["g1"].paneIds).toEqual(["topic-orphan"]);

    paneReducer(state, {
      type: "PURGE_ORPHAN_PANE",
      payload: { id: "topic-orphan" },
    });

    expect(state.panes["topic-orphan"]).toBeUndefined();
    expect(state.groups["g1"]).toBeUndefined(); // ghost group cleaned
    expect(state.closedStack.length).toBe(0); // ← key invariant
  });

  test("PURGE_ORPHAN_PANE removes id from EVERY group's paneIds", () => {
    const state = blankState();
    // Seed two groups that both reference the same orphan id (unlikely
    // in practice but the reducer should be idempotent across groups).
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "orphan", type: "chat", groupId: "g1" },
    });
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "keep", type: "chat", groupId: "g2" },
    });
    // Manually inject the orphan id into g2.paneIds (simulates a corrupted
    // hydrate where the same pane id appears in multiple groups).
    state.groups["g2"].paneIds.push("orphan");

    paneReducer(state, {
      type: "PURGE_ORPHAN_PANE",
      payload: { id: "orphan" },
    });

    expect(state.groups["g1"]).toBeUndefined(); // emptied → cleaned
    expect(state.groups["g2"].paneIds).toEqual(["keep"]); // orphan removed
    expect(state.panes["orphan"]).toBeUndefined();
  });

  test("PURGE_ORPHAN_PANE strips the orphan from project-layout panes/tabOrder/focusedPaneId", () => {
    const state = blankState();
    state.projects["/proj"] = {
      projectPath: "/proj",
      groups: [
        {
          id: "pgroup1",
          paneIds: ["orphan", "keep"],
          splitRatio: 0.5,
          splitAxis: "horizontal",
        },
      ],
      panes: {
        orphan: { id: "orphan", type: "chat", title: "" },
        keep: { id: "keep", type: "chat", title: "" },
      },
      groupOrder: ["pgroup1"],
      tabOrder: ["orphan", "keep"],
      focusedPaneId: "orphan",
      lastOpenedAt: 0,
    };
    // Also seed the top-level so the reducer doesn't bail at the wasInState guard.
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "orphan", type: "chat", groupId: "g1" },
    });

    paneReducer(state, {
      type: "PURGE_ORPHAN_PANE",
      payload: { id: "orphan" },
    });

    const layout = state.projects["/proj"];
    expect(layout.panes["orphan"]).toBeUndefined();
    expect(layout.panes["keep"]).toBeDefined();
    expect(layout.groups[0].paneIds).toEqual(["keep"]);
    expect(layout.tabOrder).toEqual(["keep"]);
    expect(layout.focusedPaneId).toBeNull();
  });

  test("PURGE_ORPHAN_PANE on unknown id is a no-op (idempotent)", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "keep", type: "chat", groupId: "g1" },
    });
    const beforePanes = { ...state.panes };
    const beforeGroupIds = [...state.groups["g1"].paneIds];

    paneReducer(state, {
      type: "PURGE_ORPHAN_PANE",
      payload: { id: "does-not-exist" },
    });

    expect(state.panes).toEqual(beforePanes);
    expect(state.groups["g1"].paneIds).toEqual(beforeGroupIds);
  });

  test("PURGE_ORPHAN_PANE clears focusedPaneId if the orphan was focused", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "orphan", type: "chat", groupId: "g1" },
    });
    state.focusedPaneId = "orphan";

    paneReducer(state, {
      type: "PURGE_ORPHAN_PANE",
      payload: { id: "orphan" },
    });

    expect(state.focusedPaneId).toBeNull();
  });
});

describe("HYDRATE_FROM_SNAPSHOT cross-client UNION (multi-client clobber)", () => {
  const mkPane = (id: string, type = "project") => ({ id, type, title: id }) as any;
  const mkRec = (id: string, closedAt: number) =>
    ({ id, closedAt, pane: mkPane(id), groupId: "group:default", groupIndex: 0, level: "app" }) as any;
  const grp = (paneIds: string[]) =>
    ({ id: "group:default", paneIds, splitRatio: 0.5, splitAxis: "horizontal" as const });
  const hydrate = (state: PaneState, snapshot: Record<string, unknown>) =>
    paneReducer(state, { type: "HYDRATE_FROM_SNAPSHOT", payload: { snapshot } } as any);

  test("a local-only pane survives a remote snapshot that omits it (the clobber fix)", () => {
    // THIS client just opened project:P. A newer snapshot from another client
    // (desktop ⇄ PWA ⇄ second window) never saw it and lists only project:Q.
    const state = blankState();
    state.lastServerSeq = 5;
    state.panes["project:P"] = mkPane("project:P");
    state.groups["group:default"] = grp(["project:P"]);
    state.groupOrder = ["group:default"];

    hydrate(state, {
      panes: { "project:Q": mkPane("project:Q") },
      groups: { "group:default": grp(["project:Q"]) },
      closedStack: [], groupOrder: ["group:default"], lastSeq: 10, server_seq: 10, seq: 10,
    });

    // UNION, not replace: project:P is NOT clobbered, project:Q is adopted.
    expect(state.panes["project:P"]).toBeDefined();
    expect(state.panes["project:Q"]).toBeDefined();
    expect(state.groups["group:default"].paneIds).toContain("project:P");
    expect(state.groups["group:default"].paneIds).toContain("project:Q");
  });

  test("concurrent opens on two clients converge to the union", () => {
    const state = blankState();
    state.lastServerSeq = 1;
    state.panes["chat:Y"] = mkPane("chat:Y", "chat");
    state.groups["group:default"] = grp(["chat:Y"]);
    state.groupOrder = ["group:default"];
    hydrate(state, {
      panes: { "chat:X": mkPane("chat:X", "chat") },
      groups: { "group:default": grp(["chat:X"]) },
      closedStack: [], groupOrder: ["group:default"], lastSeq: 2, server_seq: 2, seq: 2,
    });
    expect([...state.groups["group:default"].paneIds].sort()).toEqual(["chat:X", "chat:Y"]);
  });

  test("a pane CLOSED on another client (in clean.closedStack) is removed, not resurrected", () => {
    const state = blankState();
    state.lastServerSeq = 5;
    state.panes["project:P"] = mkPane("project:P");
    state.groups["group:default"] = grp(["project:P"]);
    state.groupOrder = ["group:default"];
    // Remote closed project:P → it rides in the incoming closedStack (tombstone)
    // and is absent from the incoming panes/groups.
    hydrate(state, {
      panes: {},
      groups: { "group:default": grp([]) },
      closedStack: [mkRec("project:P", 1000)],
      groupOrder: ["group:default"], lastSeq: 10, server_seq: 10, seq: 10,
    });
    // The tombstone wins over the union — P is gone, and the union did NOT
    // re-add it from local state.
    expect(state.groups["group:default"].paneIds).not.toContain("project:P");
    expect(state.panes["project:P"]).toBeUndefined();
  });

  test("closedStack is MERGED (union), not replaced — an unsynced local close survives", () => {
    const state = blankState();
    state.lastServerSeq = 5;
    state.closedStack = [mkRec("chat:local", 2000)];
    hydrate(state, {
      panes: {}, groups: {},
      closedStack: [mkRec("chat:remote", 1000)],
      groupOrder: [], lastSeq: 10, server_seq: 10, seq: 10,
    });
    const ids = state.closedStack.map((r) => r.id);
    expect(ids).toContain("chat:local");
    expect(ids).toContain("chat:remote");
  });

  test("device-local drafts are preserved through a union hydrate", () => {
    const state = blankState();
    state.lastServerSeq = 5;
    state.panes["draft:abc"] = mkPane("draft:abc", "chat");
    state.groups["group:default"] = grp(["draft:abc"]);
    state.groupOrder = ["group:default"];
    hydrate(state, {
      panes: { "chat:R": mkPane("chat:R", "chat") },
      groups: { "group:default": grp(["chat:R"]) },
      closedStack: [], groupOrder: ["group:default"], lastSeq: 10, server_seq: 10, seq: 10,
    });
    expect(state.panes["draft:abc"]).toBeDefined();
    expect(state.groups["group:default"].paneIds).toContain("draft:abc");
  });
});
