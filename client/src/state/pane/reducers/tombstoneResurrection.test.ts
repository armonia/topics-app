import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { selectLocalSnapshot } from "../selectors";
import { DEFAULT_SPACE_ID } from "../types";
import { overTheWire } from "../testSupport";
import type { PaneState, Pane } from "../types";

/**
 * Regression contract for the "closed browser/terminal/utility tab reappears
 * after reload" bug. A durable (store-resident) non-chat pane must stay closed
 * across a reload and across a stale cross-client/cross-tab union — chat tabs
 * were protected by the archived-topic filter, these had no equivalent backstop.
 *
 * The tombstone is the reducer's `closedStack`. These lock:
 *   - close → serialize (selectLocalSnapshot) → hydrate fresh store → pane stays
 *     closed (boot round-trip).
 *   - a stale incoming snapshot that STILL lists the closed pane does NOT
 *     resurrect it (the union must respect the LOCAL tombstone, not just the
 *     remote one).
 *   - re-opening the same id via OPEN_PANE retracts the tombstone so a genuine
 *     reopen survives the next hydrate (⇧⌘T / persistBrowserPane re-entry).
 *
 * @covers TAB-SYNC-01, TAB-SYNC-02
 */

const blank = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  spaces: {},
  activeSpaceId: DEFAULT_SPACE_ID,
  focusedPaneId: null,
  groupOrder: [],
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

const openPane = (state: PaneState, id: string, type: Pane["type"] = "browser") =>
  paneReducer(state, {
    type: "OPEN_PANE",
    payload: { id, type, groupId: "group:default" },
  });

const closePane = (state: PaneState, id: string, groupIndex = 0) =>
  paneReducer(state, {
    type: "CLOSE_PANE",
    payload: { id, groupId: "group:default", groupIndex },
  });

// Simulate a full reload: serialize the local snapshot, hydrate a fresh store
// (warm-boot: lastServerSeq 0, empty panes → the reducer's warm-boot escape
// lets a server_seq-0 snapshot apply).
const reload = (prev: PaneState): PaneState => {
  const snap = overTheWire(selectLocalSnapshot(prev));
  const fresh = blank();
  paneReducer(fresh, {
    type: "HYDRATE_FROM_SNAPSHOT",
    payload: { snapshot: { ...snap, server_seq: 0, seq: 0 } },
  });
  return fresh;
};

describe("closed durable pane stays closed after reload", () => {
  test("open then close then reload — browser pane does not reappear", () => {
    const s = blank();
    openPane(s, "browser:ctx1");
    closePane(s, "browser:ctx1");
    const after = reload(s);
    expect(after.panes["browser:ctx1"]).toBeUndefined();
    expect(after.groups["group:default"]?.paneIds ?? []).not.toContain("browser:ctx1");
    // The tombstone rides along in the snapshot so a subsequent stale union
    // still can't resurrect it.
    expect(after.closedStack.some((r) => r.id === "browser:ctx1")).toBe(true);
  });

  test("terminal pane close survives reload the same way", () => {
    const s = blank();
    openPane(s, "terminal:sess1", "terminal");
    closePane(s, "terminal:sess1");
    const after = reload(s);
    expect(after.panes["terminal:sess1"]).toBeUndefined();
    expect(after.groups["group:default"]?.paneIds ?? []).not.toContain("terminal:sess1");
  });
});

describe("local tombstone beats a stale incoming union", () => {
  test("a snapshot that still lists the closed pane cannot resurrect it", () => {
    const s = blank();
    openPane(s, "browser:ctx1");
    closePane(s, "browser:ctx1");
    // A newer-by-seq snapshot from a client that never learned about the close
    // (its closedStack is empty, its panes still hold the tab). LWW gate passes
    // on server_seq, but the LOCAL closedStack must win and strip the pane.
    paneReducer(s, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: { "browser:ctx1": { id: "browser:ctx1", type: "browser" } },
          groups: {
            "group:default": {
              id: "group:default",
              paneIds: ["browser:ctx1"],
              splitRatio: 0.5,
              splitAxis: "horizontal",
            },
          },
          groupOrder: ["group:default"],
          closedStack: [],
          server_seq: 999,
          seq: 999,
        },
      },
    });
    expect(s.panes["browser:ctx1"]).toBeUndefined();
    expect(s.groups["group:default"]?.paneIds ?? []).not.toContain("browser:ctx1");
  });

  test("the strip prunes an emptied non-default group but keeps group:default", () => {
    const s = blank();
    // Two panes in a non-default group, both tombstoned; the group must be
    // pruned so no ghost tab-bar slot survives. group:default is preserved even
    // when emptied (it is the app-level dispatch target).
    paneReducer(s, {
      type: "OPEN_PANE",
      payload: { id: "browser:a", type: "browser", groupId: "g-split" },
    });
    paneReducer(s, {
      type: "CLOSE_PANE",
      payload: { id: "browser:a", groupId: "g-split", groupIndex: 0 },
    });
    // Re-open a fresh one in the same non-default group so it exists at hydrate,
    // then feed a stale snapshot that lists the tombstoned id again.
    openPane(s, "browser:keep");
    paneReducer(s, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: {
            "browser:a": { id: "browser:a", type: "browser" },
            "browser:keep": { id: "browser:keep", type: "browser" },
          },
          groups: {
            "g-split": {
              id: "g-split",
              paneIds: ["browser:a"],
              splitRatio: 0.5,
              splitAxis: "horizontal",
            },
            "group:default": {
              id: "group:default",
              paneIds: ["browser:keep"],
              splitRatio: 0.5,
              splitAxis: "horizontal",
            },
          },
          groupOrder: ["g-split", "group:default"],
          closedStack: [],
          server_seq: 999,
          seq: 999,
        },
      },
    });
    expect(s.panes["browser:a"]).toBeUndefined();
    expect(s.groups["g-split"]).toBeUndefined();
    expect(s.groupOrder).not.toContain("g-split");
    expect(s.groups["group:default"]).toBeDefined();
    expect(s.groups["group:default"].paneIds).toContain("browser:keep");
  });
});

describe("re-opening clears the tombstone", () => {
  test("OPEN_PANE on a tombstoned id retracts the closure and survives reload", () => {
    const s = blank();
    openPane(s, "browser:ctx1");
    closePane(s, "browser:ctx1");
    expect(s.closedStack.some((r) => r.id === "browser:ctx1")).toBe(true);
    // Re-open the SAME id (persistBrowserPane path re-navigates to the same
    // browser:<ctx> id without going through the reopen-closed-tab flow).
    openPane(s, "browser:ctx1");
    expect(s.closedStack.some((r) => r.id === "browser:ctx1")).toBe(false);
    const after = reload(s);
    expect(after.groups["group:default"].paneIds).toContain("browser:ctx1");
  });

  test("after OPEN_PANE-reopen, a stale union that re-lists the pane keeps it (no false strip)", () => {
    const s = blank();
    openPane(s, "browser:ctx1");
    closePane(s, "browser:ctx1");
    openPane(s, "browser:ctx1"); // reopen clears the tombstone
    // A stale snapshot (re-)lists the pane as open, empty closedStack. Because
    // the local tombstone was cleared by the reopen, the strip is a no-op.
    paneReducer(s, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: { "browser:ctx1": { id: "browser:ctx1", type: "browser" } },
          groups: {
            "group:default": {
              id: "group:default",
              paneIds: ["browser:ctx1"],
              splitRatio: 0.5,
              splitAxis: "horizontal",
            },
          },
          groupOrder: ["group:default"],
          closedStack: [],
          server_seq: 999,
          seq: 999,
        },
      },
    });
    expect(s.groups["group:default"].paneIds).toContain("browser:ctx1");
  });

  test("UNDO_CLOSE-consumed record no longer strips the restored pane", () => {
    const s = blank();
    openPane(s, "browser:ctx1");
    closePane(s, "browser:ctx1");
    paneReducer(s, { type: "UNDO_CLOSE" });
    // Record consumed → no tombstone → the restored pane survives a hydrate.
    expect(s.closedStack.some((r) => r.id === "browser:ctx1")).toBe(false);
    const after = reload(s);
    expect(after.groups["group:default"].paneIds).toContain("browser:ctx1");
  });
});
