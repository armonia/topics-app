import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { selectLocalSnapshot, selectSyncableSnapshot } from "../selectors";
import { overTheWire } from "../testSupport";
import type { PaneState, Pane } from "../types";

/**
 * Tombstone behaviour with Spazi active. The pre-Spazi tombstone tests used a
 * store without `spaces`/`activeSpaceId`; these exercise the close→reload and
 * multi-client union paths for panes that carry a `spaceId` and for a window
 * whose active space is non-default.
 */

const blank = (activeSpaceId = "space:default"): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId,
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

const open = (s: PaneState, id: string, type: Pane["type"] = "browser") =>
  paneReducer(s, { type: "OPEN_PANE", payload: { id, type, groupId: "group:default" } });

const close = (s: PaneState, id: string) => {
  const g = s.groups["group:default"];
  const idx = g ? g.paneIds.indexOf(id) : 0;
  paneReducer(s, { type: "CLOSE_PANE", payload: { id, groupId: "group:default", groupIndex: idx } });
};

const reload = (prev: PaneState): PaneState => {
  const snap = overTheWire(selectLocalSnapshot(prev));
  const fresh = blank(prev.activeSpaceId);
  paneReducer(fresh, {
    type: "HYDRATE_FROM_SNAPSHOT",
    payload: { snapshot: { ...snap, server_seq: 0, seq: 0 } },
  });
  return fresh;
};

const hasPane = (s: PaneState, id: string) =>
  Boolean(s.panes[id]) && (s.groups["group:default"]?.paneIds ?? []).includes(id);

describe("close→reload with a non-default active space", () => {
  test("a pane created in a custom space, then closed, stays closed after reload", () => {
    const s = blank();
    // Create a real space and switch to it.
    paneReducer(s, { type: "SPACE_UPSERT", payload: { space: { id: "space:work", name: "Work" } } });
    paneReducer(s, { type: "SET_ACTIVE_SPACE", payload: { id: "space:work" } });
    expect(s.activeSpaceId).toBe("space:work");

    // OPEN stamps the active space onto the pane.
    open(s, "browser:X");
    expect(s.panes["browser:X"]?.spaceId).toBe("space:work");

    close(s, "browser:X");
    const after = reload(s);
    expect(hasPane(after, "browser:X")).toBe(false);
    expect(after.closedStack.some((r) => r.id === "browser:X")).toBe(true);
  });
});

describe("close a pane that lives in a DIFFERENT (non-active) space", () => {
  test("closing a hidden-space pane still tombstones it and it stays closed", () => {
    const s = blank();
    // Two spaces. Open A in 'work', switch to default, open B in default.
    paneReducer(s, { type: "SPACE_UPSERT", payload: { space: { id: "space:work", name: "Work" } } });
    paneReducer(s, { type: "SET_ACTIVE_SPACE", payload: { id: "space:work" } });
    open(s, "browser:inWork");
    paneReducer(s, { type: "SET_ACTIVE_SPACE", payload: { id: "space:default" } });
    open(s, "browser:inDefault");

    // Now close the pane that lives in the *other* (non-active) space.
    close(s, "browser:inWork");
    expect(hasPane(s, "browser:inWork")).toBe(false);

    const after = reload(s);
    expect(hasPane(after, "browser:inWork")).toBe(false);
    expect(hasPane(after, "browser:inDefault")).toBe(true);
  });
});

describe("multi-client union preserves spaceId AND the tombstone together", () => {
  test("stale peer that still lists a space-stamped pane cannot resurrect it", () => {
    const A = blank();
    const B = blank();

    // A creates a space, opens X in it, syncs to B.
    paneReducer(A, { type: "SPACE_UPSERT", payload: { space: { id: "space:work", name: "Work" } } });
    paneReducer(A, { type: "SET_ACTIVE_SPACE", payload: { id: "space:work" } });
    open(A, "browser:X");
    const snapA = overTheWire(selectSyncableSnapshot(A));
    paneReducer(B, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: { snapshot: { ...snapA, server_seq: 1, seq: 1 } },
    });
    expect(hasPane(B, "browser:X")).toBe(true);
    expect(B.panes["browser:X"]?.spaceId).toBe("space:work");

    // B closes X → tombstone on B.
    close(B, "browser:X");

    // A (stale — still lists X, empty closedStack) PUTs again.
    const snapA2 = overTheWire(selectSyncableSnapshot(A));
    paneReducer(B, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: { snapshot: { ...snapA2, server_seq: 2, seq: 2 } },
    });
    expect(hasPane(B, "browser:X")).toBe(false);
  });
});
