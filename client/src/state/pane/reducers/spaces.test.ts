import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { mergeSpaces, resolvePaneSpace, isLiveSpaceId, liveSpaceCount, spacesReducer } from "./spaces";
import type { PaneState, SpaceMeta } from "../types";
import { DEFAULT_SPACE_ID, SPACES_MAX } from "../types";

const blankState = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId: DEFAULT_SPACE_ID,
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

const space = (id: string, over: Partial<SpaceMeta> = {}): SpaceMeta => ({
  id,
  name: id,
  order: 0,
  updatedAt: 1000,
  ...over,
});

describe("SPACE_UPSERT", () => {
  test("creates a space and stamps updatedAt", () => {
    const state = blankState();
    const before = Date.now();
    paneReducer(state, {
      type: "SPACE_UPSERT",
      payload: { space: { id: "space:a", name: "Lavoro" } },
    });
    const meta = state.spaces["space:a"];
    expect(meta).toBeDefined();
    expect(meta.name).toBe("Lavoro");
    expect(meta.updatedAt).toBeGreaterThanOrEqual(before);
    expect(meta.deleted).toBeUndefined();
  });

  test("rename keeps order and bumps updatedAt", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a", { name: "Old", order: 3, updatedAt: 1 });
    paneReducer(state, {
      type: "SPACE_UPSERT",
      payload: { space: { id: "space:a", name: "New" } },
    });
    expect(state.spaces["space:a"].name).toBe("New");
    expect(state.spaces["space:a"].order).toBe(3);
    expect(state.spaces["space:a"].updatedAt).toBeGreaterThan(1);
  });

  test("refuses the default space id (implicit, never a record)", () => {
    const state = blankState();
    paneReducer(state, {
      type: "SPACE_UPSERT",
      payload: { space: { id: DEFAULT_SPACE_ID, name: "Hijack" } },
    });
    expect(state.spaces[DEFAULT_SPACE_ID]).toBeUndefined();
  });

  test("upserting a deleted id revives it (tombstone cleared)", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a", { deleted: true });
    paneReducer(state, {
      type: "SPACE_UPSERT",
      payload: { space: { id: "space:a", name: "Back" } },
    });
    expect(state.spaces["space:a"].deleted).toBeUndefined();
    expect(state.spaces["space:a"].name).toBe("Back");
  });

  test("new spaces get an order after the current tail", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a", { order: 5 });
    paneReducer(state, { type: "SPACE_UPSERT", payload: { space: { id: "space:b" } } });
    expect(state.spaces["space:b"].order).toBeGreaterThan(5);
  });
});

describe("SPACE_DELETE", () => {
  test("soft-deletes (tombstone-in-record) and reassigns member panes to default", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a", { updatedAt: 1 });
    state.panes["chat:t1"] = { id: "chat:t1", type: "chat", spaceId: "space:a" };
    state.panes["chat:t2"] = { id: "chat:t2", type: "chat" };

    paneReducer(state, { type: "SPACE_DELETE", payload: { id: "space:a" } });

    expect(state.spaces["space:a"].deleted).toBe(true);
    expect(state.spaces["space:a"].updatedAt).toBeGreaterThan(1);
    // Absent ⟺ default: the field is DROPPED, not stamped with the default id.
    expect(state.panes["chat:t1"].spaceId).toBeUndefined();
    expect(state.panes["chat:t2"].spaceId).toBeUndefined();
  });

  test("refuses the default space", () => {
    const state = blankState();
    paneReducer(state, { type: "SPACE_DELETE", payload: { id: DEFAULT_SPACE_ID } });
    expect(state.spaces[DEFAULT_SPACE_ID]).toBeUndefined();
  });

  test("deleting the ACTIVE space falls the window back to default", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.activeSpaceId = "space:a";
    paneReducer(state, { type: "SPACE_DELETE", payload: { id: "space:a" } });
    expect(state.activeSpaceId).toBe(DEFAULT_SPACE_ID);
  });

  test("mints a tombstone even for a locally-unknown id (delete still propagates)", () => {
    const state = blankState();
    paneReducer(state, { type: "SPACE_DELETE", payload: { id: "space:ghost" } });
    expect(state.spaces["space:ghost"].deleted).toBe(true);
  });
});

describe("SET_ACTIVE_SPACE (device-local + focus handoff)", () => {
  const withPanes = (): PaneState => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.groups["group:default"] = {
      id: "group:default",
      paneIds: ["chat:t1", "chat:t2", "chat:t3"],
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.groupOrder = ["group:default"];
    state.panes["chat:t1"] = { id: "chat:t1", type: "chat" }; // default space
    state.panes["chat:t2"] = { id: "chat:t2", type: "chat", spaceId: "space:a" };
    state.panes["chat:t3"] = { id: "chat:t3", type: "chat", spaceId: "space:a" };
    return state;
  };

  test("switches activeSpaceId and hands focus to the first visible pane", () => {
    const state = withPanes();
    state.focusedPaneId = "chat:t1";
    paneReducer(state, { type: "SET_ACTIVE_SPACE", payload: { id: "space:a" } });
    expect(state.activeSpaceId).toBe("space:a");
    expect(state.focusedPaneId).toBe("chat:t2"); // first pane in space:a
  });

  test("keeps focus when the focused pane lives in the target space", () => {
    const state = withPanes();
    state.activeSpaceId = "space:a";
    state.focusedPaneId = "chat:t3";
    paneReducer(state, { type: "SET_ACTIVE_SPACE", payload: { id: DEFAULT_SPACE_ID } });
    expect(state.focusedPaneId).toBe("chat:t1");
    // …and back: t3 is in space:a, focus stays if already valid there.
    state.focusedPaneId = "chat:t3";
    paneReducer(state, { type: "SET_ACTIVE_SPACE", payload: { id: "space:a" } });
    expect(state.focusedPaneId).toBe("chat:t3");
  });

  test("switching to an EMPTY space focuses null", () => {
    const state = withPanes();
    state.spaces["space:empty"] = space("space:empty");
    state.focusedPaneId = "chat:t1";
    paneReducer(state, { type: "SET_ACTIVE_SPACE", payload: { id: "space:empty" } });
    expect(state.activeSpaceId).toBe("space:empty");
    expect(state.focusedPaneId).toBeNull();
  });

  test("a dead/unknown target resolves to the default space", () => {
    const state = withPanes();
    state.activeSpaceId = "space:a";
    paneReducer(state, { type: "SET_ACTIVE_SPACE", payload: { id: "space:ghost" } });
    expect(state.activeSpaceId).toBe(DEFAULT_SPACE_ID);
    const state2 = withPanes();
    state2.spaces["space:dead"] = space("space:dead", { deleted: true });
    state2.activeSpaceId = "space:a";
    paneReducer(state2, { type: "SET_ACTIVE_SPACE", payload: { id: "space:dead" } });
    expect(state2.activeSpaceId).toBe(DEFAULT_SPACE_ID);
  });

  test("tolerates a legacy state object without the spaces field", () => {
    const state = blankState();
    // Simulate a pre-Spazi fixture (spacesReducer must not crash).
    delete (state as Partial<PaneState>).spaces;
    spacesReducer(state, { type: "SET_ACTIVE_SPACE", payload: { id: "space:ghost" } });
    expect(state.activeSpaceId).toBe(DEFAULT_SPACE_ID);
  });
});

describe("OPEN_PANE spaceId stamping (the ONE central assignment point)", () => {
  test("stamps the active space onto a newly opened pane", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.activeSpaceId = "space:a";
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", groupId: "group:default" },
    });
    expect(state.panes["chat:t1"].spaceId).toBe("space:a");
  });

  test("the default space is stored as ABSENT (canonical encoding)", () => {
    const state = blankState();
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", groupId: "group:default" },
    });
    expect(state.panes["chat:t1"].spaceId).toBeUndefined();
  });

  test("respects an explicit payload spaceId over the active space", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.spaces["space:b"] = space("space:b");
    state.activeSpaceId = "space:a";
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", groupId: "group:default", spaceId: "space:b" },
    });
    expect(state.panes["chat:t1"].spaceId).toBe("space:b");
  });

  test("re-OPEN of a known pane keeps its membership (no teleport into the active space)", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.activeSpaceId = "space:a";
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "browser:ctx", type: "browser", groupId: "group:default" },
    });
    expect(state.panes["browser:ctx"].spaceId).toBe("space:a");
    // Switch space, then re-OPEN the same id (persistBrowserPane path).
    state.activeSpaceId = DEFAULT_SPACE_ID;
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "browser:ctx", type: "browser", groupId: "group:default" },
    });
    expect(state.panes["browser:ctx"].spaceId).toBe("space:a");
  });

  test("re-OPEN of a known pane in the DEFAULT space stays default (absent ⟺ default must not fall through to the active space)", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    // Open while the DEFAULT space is active → membership stored as ABSENT.
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "browser:ctx", type: "browser", groupId: "group:default" },
    });
    expect(state.panes["browser:ctx"].spaceId).toBeUndefined();
    // Switch to a user space, then re-OPEN the same id: the absent spaceId
    // means "default", NOT "unknown" — the pane must not teleport into
    // space:a just because it is active.
    state.activeSpaceId = "space:a";
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "browser:ctx", type: "browser", groupId: "group:default" },
    });
    expect(state.panes["browser:ctx"].spaceId).toBeUndefined();
  });
});

describe("mergeSpaces (per-id LWW, tombstone-wins, anti-clobber)", () => {
  test("disjoint creations from two devices BOTH survive (the anti-clobber case)", () => {
    const local = { "space:a": space("space:a", { updatedAt: 10 }) };
    const remote = { "space:b": space("space:b", { updatedAt: 20 }) };
    const merged = mergeSpaces(local, remote);
    expect(Object.keys(merged).sort()).toEqual(["space:a", "space:b"]);
  });

  test("per-id LWW by updatedAt — newer remote wins, older remote loses", () => {
    const local = {
      "space:a": space("space:a", { name: "local-new", updatedAt: 50 }),
      "space:b": space("space:b", { name: "local-old", updatedAt: 10 }),
    };
    const remote = {
      "space:a": space("space:a", { name: "remote-old", updatedAt: 20 }),
      "space:b": space("space:b", { name: "remote-new", updatedAt: 30 }),
    };
    const merged = mergeSpaces(local, remote);
    expect(merged["space:a"].name).toBe("local-new");
    expect(merged["space:b"].name).toBe("remote-new");
  });

  test("a NEWER deleted tombstone wins; a STALE pre-delete rename does not resurrect", () => {
    const local = { "space:a": space("space:a", { updatedAt: 10 }) };
    const remoteDelete = { "space:a": space("space:a", { updatedAt: 20, deleted: true }) };
    expect(mergeSpaces(local, remoteDelete)["space:a"].deleted).toBe(true);

    const localDeleted = { "space:a": space("space:a", { updatedAt: 30, deleted: true }) };
    const remoteStaleRename = { "space:a": space("space:a", { name: "Zombie", updatedAt: 20 }) };
    expect(mergeSpaces(localDeleted, remoteStaleRename)["space:a"].deleted).toBe(true);
  });

  test("delete is ABSORBING: a rename with a HIGHER updatedAt still cannot resurrect (clock skew)", () => {
    // The real resurrection bug: a rename that raced the delete (or a skewed
    // clock) carries a numerically-higher updatedAt than the tombstone. Plain
    // updatedAt-LWW would un-delete the space; the absorbing latch must not.
    const localDeleted = { "space:a": space("space:a", { updatedAt: 20, deleted: true }) };
    const remoteNewerRename = { "space:a": space("space:a", { name: "Zombie", updatedAt: 99 }) };
    const merged = mergeSpaces(localDeleted, remoteNewerRename)["space:a"];
    expect(merged.deleted).toBe(true);
    // Latest fields are kept on the tombstone (harmless), but it stays deleted.
    expect(merged.name).toBe("Zombie");

    // Symmetric: local rename is newer, remote delete is older — still deleted.
    const localNewerRename = { "space:a": space("space:a", { name: "Live?", updatedAt: 99 }) };
    const remoteOlderDelete = { "space:a": space("space:a", { updatedAt: 20, deleted: true }) };
    expect(mergeSpaces(localNewerRename, remoteOlderDelete)["space:a"].deleted).toBe(true);
  });

  test("never admits a default-space record", () => {
    const merged = mergeSpaces({}, { [DEFAULT_SPACE_ID]: space(DEFAULT_SPACE_ID) });
    expect(merged[DEFAULT_SPACE_ID]).toBeUndefined();
  });

  test("caps at SPACES_MAX keeping the most-recently-updated", () => {
    const remote: Record<string, SpaceMeta> = {};
    for (let i = 0; i < SPACES_MAX + 10; i++) {
      remote[`space:${i}`] = space(`space:${i}`, { updatedAt: i });
    }
    const merged = mergeSpaces({}, remote);
    expect(Object.keys(merged)).toHaveLength(SPACES_MAX);
    expect(merged["space:0"]).toBeUndefined(); // oldest evicted
    expect(merged[`space:${SPACES_MAX + 9}`]).toBeDefined(); // newest kept
  });

  test("tolerates undefined inputs", () => {
    expect(mergeSpaces(undefined, undefined)).toEqual({});
  });
});

describe("resolvePaneSpace / isLiveSpaceId", () => {
  test("absent, unknown and deleted space ids resolve to the default space", () => {
    const spaces = {
      "space:a": space("space:a"),
      "space:dead": space("space:dead", { deleted: true }),
    };
    expect(resolvePaneSpace({ spaceId: undefined }, spaces)).toBe(DEFAULT_SPACE_ID);
    expect(resolvePaneSpace({ spaceId: "space:ghost" }, spaces)).toBe(DEFAULT_SPACE_ID);
    expect(resolvePaneSpace({ spaceId: "space:dead" }, spaces)).toBe(DEFAULT_SPACE_ID);
    expect(resolvePaneSpace({ spaceId: "space:a" }, spaces)).toBe("space:a");
    expect(resolvePaneSpace(undefined, spaces)).toBe(DEFAULT_SPACE_ID);
  });

  test("isLiveSpaceId: default always live, deleted/unknown not", () => {
    const spaces = { "space:dead": space("space:dead", { deleted: true }) };
    expect(isLiveSpaceId(DEFAULT_SPACE_ID, spaces)).toBe(true);
    expect(isLiveSpaceId("space:dead", spaces)).toBe(false);
    expect(isLiveSpaceId("space:ghost", spaces)).toBe(false);
  });

  test("liveSpaceCount ignores soft-deleted tombstones (the create-cap must not deadlock)", () => {
    expect(liveSpaceCount(undefined)).toBe(0);
    expect(liveSpaceCount({})).toBe(0);
    const spaces = {
      "space:a": space("space:a"),
      "space:b": space("space:b"),
      "space:dead": space("space:dead", { deleted: true }),
    };
    // 3 raw keys but only 2 live — the gate must see 2, else 32 create/delete
    // cycles would permanently hide "+ New Space".
    expect(Object.keys(spaces).length).toBe(3);
    expect(liveSpaceCount(spaces)).toBe(2);
  });
});

describe("Spazi × existing invariants", () => {
  test("UNDO_CLOSE into a deleted space resolves to default", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", groupId: "group:default", spaceId: "space:a" },
    });
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "group:default", groupIndex: 0 },
    });
    // Record still carries the membership.
    expect(state.closedStack[0].pane.spaceId).toBe("space:a");
    paneReducer(state, { type: "SPACE_DELETE", payload: { id: "space:a" } });
    paneReducer(state, { type: "UNDO_CLOSE" });
    expect(state.panes["chat:t1"]).toBeDefined();
    expect(state.panes["chat:t1"].spaceId).toBeUndefined(); // → default
  });

  test("UNDO_CLOSE into a LIVE space preserves membership", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", groupId: "group:default", spaceId: "space:a" },
    });
    paneReducer(state, {
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "group:default", groupIndex: 0 },
    });
    paneReducer(state, { type: "UNDO_CLOSE" });
    expect(state.panes["chat:t1"].spaceId).toBe("space:a");
  });

  test("PANE_ID_REMAP preserves spaceId (draft → topic promotion)", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.activeSpaceId = "space:a";
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "draft:x", type: "chat", groupId: "group:default" },
    });
    expect(state.panes["draft:x"].spaceId).toBe("space:a");
    paneReducer(state, {
      type: "PANE_ID_REMAP",
      payload: { from: "draft:x", to: "topic-1", updates: { topicId: "topic-1" } },
    });
    expect(state.panes["topic-1"].spaceId).toBe("space:a");
  });

  test("HYDRATE merges the spaces registry per-id (never wholesale) and keeps local-only panes' membership", () => {
    const state = blankState();
    state.lastServerSeq = 1;
    state.spaces["space:local"] = space("space:local", { updatedAt: 100 });
    paneReducer(state, {
      type: "OPEN_PANE",
      payload: { id: "chat:local", type: "chat", groupId: "group:default", spaceId: "space:local" },
    });

    paneReducer(state, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          seq: 2,
          server_seq: 2,
          panes: { "chat:remote": { id: "chat:remote", type: "chat", title: "", spaceId: "space:remote" } },
          groups: {
            "group:default": { id: "group:default", paneIds: ["chat:remote"], splitRatio: 0.5, splitAxis: "horizontal" },
          },
          groupOrder: ["group:default"],
          closedStack: [],
          spaces: { "space:remote": space("space:remote", { updatedAt: 200 }) },
        },
      },
    });

    // Registry = UNION (remote didn't know space:local; it must survive).
    expect(state.spaces["space:local"]).toBeDefined();
    expect(state.spaces["space:remote"]).toBeDefined();
    // Local-only pane kept (UNION) with its membership intact.
    expect(state.panes["chat:local"].spaceId).toBe("space:local");
    // Remote pane applied with its membership.
    expect(state.panes["chat:remote"].spaceId).toBe("space:remote");
  });

  test("HYDRATE never touches activeSpaceId (device-local contract)", () => {
    const state = blankState();
    state.spaces["space:a"] = space("space:a");
    state.activeSpaceId = "space:a";
    state.lastServerSeq = 1;
    paneReducer(state, {
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          seq: 2,
          server_seq: 2,
          // An adversarial payload smuggling the field — sanitize drops it.
          activeSpaceId: "space:hijack",
          panes: {},
          groups: {},
          closedStack: [],
        } as never,
      },
    });
    expect(state.activeSpaceId).toBe("space:a");
  });
});
