import { describe, test, expect } from "bun:test";
import { selectSyncableSnapshot, selectLocalSnapshot, filterVisiblePaneIds, selectVisiblePaneIds } from "./selectors";
import type { PaneState, Pane, ClosedPaneRecord } from "./types";

const blankState = (): PaneState => ({
  panes: {},
  groups: {},
  projects: {},
  closedStack: [],
  focusedPaneId: null,
  groupOrder: [],
  lastSeq: 0,
});

describe("selectSyncableSnapshot (PANE-02)", () => {
  test("omits the projects map entirely (it's no longer cross-device synced)", () => {
    // History: this test used to assert that nested
    // `snapshot.projects[path].panes[id].scrollOffset` was stripped.
    // PANE-02 evolved past that — `projects` was found to be the wrong
    // scope (per `projectLayoutSync.ts` header) and the synced result
    // wasn't authoritative anywhere, so `buildSnapshot` now drops the
    // whole `projects` field. Inner-project layouts persist locally via
    // `topics-project-panes-<hash>` instead.
    //
    // The invariant we still care about is the user-visible one: no
    // device-local field can leak across devices. Verifying that
    // `projects` simply isn't in the snapshot covers it more strongly
    // than the old per-field assertion.
    const state = blankState();
    const pane: Pane = {
      id: "chat:t1",
      type: "chat",
      title: "Hello",
      topicId: "t1",
      scrollOffset: 250,
    };
    state.projects["proj-a"] = {
      projectPath: "/tmp/proj-a",
      groups: [],
      panes: { "chat:t1": pane },
      groupOrder: [],
      tabOrder: ["chat:t1"],
      focusedPaneId: "chat:t1",
      lastOpenedAt: Date.now(),
    };

    const snapshot = selectSyncableSnapshot(state);

    expect((snapshot as { projects?: unknown }).projects).toBeUndefined();
  });

  test("strips BOTH outer and nested scrollOffset from closedStack records", () => {
    // Post-fix (device-local invariant): `ClosedPaneRecord.scrollOffset` is
    // also device-local — CLOSE_PANE no longer writes it, and the outbound
    // snapshot must not leak it either. CLOSE_PANE may have been dispatched
    // on a pre-fix client and left the value on an in-memory record; the
    // selector must strip it defensively.
    const state = blankState();
    const record: ClosedPaneRecord = {
      id: "chat:t2",
      closedAt: 1000,
      pane: { id: "chat:t2", type: "chat", title: "Bye", scrollOffset: 100 },
      groupId: "g1",
      groupIndex: 0,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      scrollOffset: 42, // outer — legacy value; must be stripped on outbound
      seq: 1,
    };
    state.closedStack = [record];

    const snapshot = selectSyncableSnapshot(state);

    // Nested pane.scrollOffset stripped
    expect(snapshot.closedStack[0].pane.scrollOffset).toBeUndefined();
    // Outer ClosedPaneRecord.scrollOffset also stripped
    expect(snapshot.closedStack[0].scrollOffset).toBeUndefined();
    // Other fields survive
    expect(snapshot.closedStack[0].id).toBe("chat:t2");
    expect(snapshot.closedStack[0].seq).toBe(1);
  });

  test("excludes focusedPaneId from snapshot", () => {
    const state = blankState();
    state.focusedPaneId = "chat:t1";

    const snapshot = selectSyncableSnapshot(state);

    expect((snapshot as Record<string, unknown>).focusedPaneId).toBeUndefined();
  });

  test("strips scrollOffset from top-level panes", () => {
    const state = blankState();
    state.panes["file:a"] = {
      id: "file:a",
      type: "file",
      title: "File A",
      scrollOffset: 300,
    };

    const snapshot = selectSyncableSnapshot(state);

    expect(snapshot.panes["file:a"].scrollOffset).toBeUndefined();
    expect(snapshot.panes["file:a"].id).toBe("file:a");
  });
});

describe("Spazi: snapshot shape (both persist variants)", () => {
  const stateWithSpaces = (): PaneState => {
    const state = blankState();
    state.spaces = {
      "space:a": { id: "space:a", name: "Lavoro", order: 1, updatedAt: 10 },
    };
    state.activeSpaceId = "space:a";
    return state;
  };

  test("selectSyncableSnapshot INCLUDES spaces and EXCLUDES activeSpaceId", () => {
    const snapshot = selectSyncableSnapshot(stateWithSpaces());
    expect(snapshot.spaces).toEqual({
      "space:a": { id: "space:a", name: "Lavoro", order: 1, updatedAt: 10 },
    });
    // Device-local (focusedPaneId pattern): activeSpaceId never leaves the
    // device via the snapshot — it lives in its own localStorage key.
    expect((snapshot as Record<string, unknown>).activeSpaceId).toBeUndefined();
  });

  test("selectLocalSnapshot INCLUDES spaces and EXCLUDES activeSpaceId too", () => {
    const snapshot = selectLocalSnapshot(stateWithSpaces());
    expect(snapshot.spaces!["space:a"].name).toBe("Lavoro");
    expect((snapshot as Record<string, unknown>).activeSpaceId).toBeUndefined();
  });

  test("pane spaceId rides the outbound snapshot (membership syncs)", () => {
    const state = stateWithSpaces();
    state.panes["chat:t1"] = { id: "chat:t1", type: "chat", title: "A", spaceId: "space:a" };
    const snapshot = selectSyncableSnapshot(state);
    expect(snapshot.panes["chat:t1"].spaceId).toBe("space:a");
  });
});

describe("Spazi: filterVisiblePaneIds / selectVisiblePaneIds (the visiblePanels derivation)", () => {
  const spaces = {
    "space:a": { id: "space:a", name: "A", order: 0, updatedAt: 1 },
    "space:dead": { id: "space:dead", name: "D", order: 1, updatedAt: 1, deleted: true as const },
  };
  const panes: Record<string, Pane> = {
    "chat:default": { id: "chat:default", type: "chat" },
    "chat:a": { id: "chat:a", type: "chat", spaceId: "space:a" },
    "chat:dead": { id: "chat:dead", type: "chat", spaceId: "space:dead" },
    "chat:ghost": { id: "chat:ghost", type: "chat", spaceId: "space:ghost" },
  };
  const order = ["chat:default", "chat:a", "chat:dead", "chat:ghost", "chat:unregistered"];

  test("default space shows default + deleted-space + unknown-space + unregistered panes", () => {
    expect(filterVisiblePaneIds(order, panes, spaces, "space:default")).toEqual([
      "chat:default",
      "chat:dead",
      "chat:ghost",
      "chat:unregistered",
    ]);
  });

  test("a user space shows only its members, preserving order", () => {
    expect(filterVisiblePaneIds(order, panes, spaces, "space:a")).toEqual(["chat:a"]);
  });

  test("selectVisiblePaneIds reads group:default through the store's active space", () => {
    const state = blankState();
    state.spaces = spaces;
    state.panes = panes;
    state.groups["group:default"] = {
      id: "group:default",
      paneIds: order,
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.activeSpaceId = "space:a";
    expect(selectVisiblePaneIds(state)).toEqual(["chat:a"]);
    state.activeSpaceId = "space:default";
    expect(selectVisiblePaneIds(state)).toEqual([
      "chat:default",
      "chat:dead",
      "chat:ghost",
      "chat:unregistered",
    ]);
  });
});
