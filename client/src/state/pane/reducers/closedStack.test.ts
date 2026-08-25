/**
 * @covers CMD-05
 *
 * The recently-closed history is durable and bounded: the pure model behind the
 * gesture that tests/e2e/reopen-closed-tab.spec.ts exercises from the UI.
 */
import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import type { ClosedPaneRecord, Pane } from "../types";
import { CLOSED_STACK_MAX } from "../types";
import { blankPaneState as blankState } from "../testSupport";

/**
 * Focused contract tests for the recently-closed-tab substrate that powers
 * ⇧⌘T (reopen), ⌘⇧U (alias) and the ⌘K "Chiuse di recente" list. The reducer's
 * `closedStack` is the single source of truth; these lock the invariants the
 * reopen-closed-tab-history change relies on:
 *   - FIFO bound at CLOSED_STACK_MAX
 *   - UNDO_CLOSE restores at the original groupIndex + focus, recreating the
 *     group if it was emptied
 *   - PANE_ID_REMAP rewrites stack record ids AND tabOrderSnapshot entries
 *   - PUSH_CLOSED_RECORD (project-inner closes) gets a reducer-assigned seq and
 *     respects the bound
 */

const chatPane = (id: string): Pane => ({ id, type: "chat", title: id, topicId: id });

const record = (id: string, over: Partial<ClosedPaneRecord> = {}): ClosedPaneRecord => ({
  id,
  closedAt: Date.now(),
  pane: chatPane(id),
  groupId: "group:default",
  groupIndex: 0,
  level: "app",
  focusedAtClose: false,
  tabOrderSnapshot: [],
  seq: 0,
  ...over,
});

describe("closedStack FIFO bound", () => {
  test("retains only the CLOSED_STACK_MAX most-recent records, dropping the oldest", () => {
    const state = blankState();
    const total = CLOSED_STACK_MAX + 5;
    for (let i = 0; i < total; i++) {
      const id = `chat:t${i}`;
      paneReducer(state, {
        type: "OPEN_PANE",
        payload: { ...chatPane(id), groupId: "group:default" },
      });
      paneReducer(state, {
        type: "CLOSE_PANE",
        payload: { id, groupId: "group:default", groupIndex: 0 },
      });
    }
    expect(state.closedStack).toHaveLength(CLOSED_STACK_MAX);
    // Oldest 5 evicted; newest retained at the tail (newest-at-end).
    expect(state.closedStack[0].id).toBe(`chat:t5`);
    expect(state.closedStack[state.closedStack.length - 1].id).toBe(`chat:t${total - 1}`);
  });
});

describe("UNDO_CLOSE restore fidelity", () => {
  test("re-inserts the pane at the original groupIndex and restores focus", () => {
    const state = blankState();
    state.groups["g1"] = { id: "g1", paneIds: ["a", "b", "c"], splitRatio: 0.5, splitAxis: "horizontal" };
    state.groupOrder = ["g1"];
    state.panes["a"] = chatPane("a");
    state.panes["b"] = chatPane("b");
    state.panes["c"] = chatPane("c");
    state.focusedPaneId = "b";

    paneReducer(state, { type: "CLOSE_PANE", payload: { id: "b", groupId: "g1", groupIndex: 1 } });
    expect(state.groups["g1"].paneIds).toEqual(["a", "c"]);
    expect(state.focusedPaneId).toBeNull();

    paneReducer(state, { type: "UNDO_CLOSE" });
    expect(state.groups["g1"].paneIds).toEqual(["a", "b", "c"]);
    expect(state.focusedPaneId).toBe("b"); // focusedAtClose was true
    expect(state.closedStack).toHaveLength(0); // record consumed
  });

  test("recreates the original group when it was emptied by the close", () => {
    const state = blankState();
    state.groups["g2"] = { id: "g2", paneIds: ["only"], splitRatio: 0.4, splitAxis: "vertical" };
    state.groupOrder = ["g2"];
    state.panes["only"] = chatPane("only");

    paneReducer(state, { type: "CLOSE_PANE", payload: { id: "only", groupId: "g2", groupIndex: 0 } });
    // Non-default empty group is pruned on close.
    expect(state.groups["g2"]).toBeUndefined();

    paneReducer(state, { type: "UNDO_CLOSE" });
    expect(state.groups["g2"]).toBeDefined();
    expect(state.groups["g2"].paneIds).toEqual(["only"]);
    expect(state.groups["g2"].splitRatio).toBe(0.4);
    expect(state.groups["g2"].splitAxis).toBe("vertical");
  });

  // PANE-03 ghost pane: the app-level undo fires an async unarchive whose
  // hydrate can resurrect the entity into state.panes BEFORE UNDO_CLOSE runs.
  // The old guard (`if (state.panes[id]) return`) then swallowed the record —
  // the pane lived in state.panes without a group slot and the tab surfaced
  // appended at the end. The undo must still re-slot it at its groupIndex.
  test("re-slots a ghost entity (in state.panes but absent from its group) at the recorded index", () => {
    const state = blankState();
    state.groups["g1"] = { id: "g1", paneIds: ["a", "c"], splitRatio: 0.5, splitAxis: "horizontal" };
    state.groupOrder = ["g1"];
    state.panes["a"] = chatPane("a");
    state.panes["c"] = chatPane("c");
    // A racing hydrate already put `b` back in state.panes — but NOT in g1.
    state.panes["b"] = chatPane("b");
    state.closedStack = [record("b", { groupId: "g1", groupIndex: 1 })];

    paneReducer(state, { type: "UNDO_CLOSE" });

    // Re-slotted at index 1 exactly once — no duplicate, back in the group.
    expect(state.groups["g1"].paneIds).toEqual(["a", "b", "c"]);
    expect(state.closedStack).toHaveLength(0);
  });

  // A racing unarchive-hydrate can re-slot the resurrected pane into its
  // recorded group but at the WRONG index (a stale peer still had it at the
  // tail). Undo must MOVE it to `groupIndex`, not leave it appended.
  test("repositions a pane already slotted in its recorded group at the wrong index", () => {
    const state = blankState();
    // Hydrate put `b` back — but appended at the tail, not at its close slot.
    state.groups["g1"] = { id: "g1", paneIds: ["a", "c", "b"], splitRatio: 0.5, splitAxis: "horizontal" };
    state.groupOrder = ["g1"];
    state.panes["a"] = chatPane("a");
    state.panes["b"] = chatPane("b");
    state.panes["c"] = chatPane("c");
    state.closedStack = [record("b", { groupId: "g1", groupIndex: 1 })];

    paneReducer(state, { type: "UNDO_CLOSE" });

    expect(state.groups["g1"].paneIds).toEqual(["a", "b", "c"]);
    expect(state.closedStack).toHaveLength(0);
  });

  test("is a no-op when the pane is already slotted in a group (genuine reopen)", () => {
    const state = blankState();
    state.groups["g1"] = { id: "g1", paneIds: ["a", "b", "c"], splitRatio: 0.5, splitAxis: "horizontal" };
    state.groupOrder = ["g1"];
    state.panes["a"] = chatPane("a");
    state.panes["b"] = chatPane("b");
    state.panes["c"] = chatPane("c");
    // Record lingering from a close that was already undone via OPEN_PANE.
    state.closedStack = [record("b", { groupId: "g1", groupIndex: 1 })];

    paneReducer(state, { type: "UNDO_CLOSE" });

    // No duplicate `b` in paneIds; record still consumed (nothing to undo).
    expect(state.groups["g1"].paneIds).toEqual(["a", "b", "c"]);
    expect(state.closedStack).toHaveLength(0);
  });
});

describe("PANE_ID_REMAP rewrites stack records", () => {
  test("rewrites a record id and tabOrderSnapshot entries from→to", () => {
    const state = blankState();
    // A live pane named `from` so the remap guard passes...
    state.groups["g1"] = { id: "g1", paneIds: ["from"], splitRatio: 0.5, splitAxis: "horizontal" };
    state.groupOrder = ["g1"];
    state.panes["from"] = chatPane("from");
    // ...and a stale closed record that also references `from`.
    state.closedStack = [record("from", { tabOrderSnapshot: ["from", "y"] })];

    paneReducer(state, { type: "PANE_ID_REMAP", payload: { from: "from", to: "to" } });

    expect(state.closedStack[0].id).toBe("to");
    expect(state.closedStack[0].tabOrderSnapshot).toEqual(["to", "y"]);
  });
});

describe("PUSH_CLOSED_RECORD (project-inner closes)", () => {
  test("assigns a reducer-owned seq and respects the FIFO bound", () => {
    const state = blankState();
    state.lastSeq = 41;
    paneReducer(state, { type: "PUSH_CLOSED_RECORD", payload: { record: record("proj:inner", { seq: 0 }) } });
    expect(state.closedStack).toHaveLength(1);
    expect(state.closedStack[0].id).toBe("proj:inner");
    expect(state.closedStack[0].seq).toBe(42); // lastSeq + 1, not the caller's 0

    // Overfill via PUSH and confirm the bound holds.
    for (let i = 0; i < CLOSED_STACK_MAX + 3; i++) {
      paneReducer(state, { type: "PUSH_CLOSED_RECORD", payload: { record: record(`p${i}`, { seq: 0 }) } });
    }
    expect(state.closedStack.length).toBe(CLOSED_STACK_MAX);
  });
});
