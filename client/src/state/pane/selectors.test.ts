import { describe, test, expect } from "bun:test";
import { selectSyncableSnapshot } from "./selectors";
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
