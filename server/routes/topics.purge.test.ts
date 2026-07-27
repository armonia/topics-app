import { describe, expect, it } from "bun:test";
import { removeTopicFromUiStateValue, retractTopicTombstoneFromUiStateValue } from "./topics";

/**
 * Unit coverage for the archive/delete purge helper. The regression it guards:
 * a chat archived/deleted must be removed from EVERY ui_state record shape,
 * including the global `pane-store-v2` snapshot — which has no `openChatTopicIds`
 * field, so the old purge silently skipped it and left a phantom tab that
 * resurfaced on other devices ("ghost tab on mobile").
 */
describe("removeTopicFromUiStateValue", () => {
  const TID = "d16d99fa-e2ca-4a6a-a201-63a205dd9eda";

  it("removes a top-level chat pane from the pane-store-v2 snapshot", () => {
    const v = {
      panes: {
        [TID]: { id: TID, type: "chat", topicId: TID, title: "Master" },
        "project:%2Ffoo": { id: "project:%2Ffoo", type: "project" },
      },
      groups: {
        "group:default": { id: "group:default", paneIds: [TID, "project:%2Ffoo"] },
      },
      groupOrder: ["group:default"],
      closedStack: [],
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(v.panes[TID as keyof typeof v.panes]).toBeUndefined();
    expect(v.panes["project:%2Ffoo"]).toBeDefined();
    expect(v.groups["group:default"].paneIds).toEqual(["project:%2Ffoo"]);
  });

  it("removes a chat pane referenced by topicId even under a prefixed pane id", () => {
    const PID = `chat:${TID}`;
    const v = {
      panes: { [PID]: { id: PID, type: "chat", topicId: TID } },
      groups: { g1: { id: "g1", paneIds: [PID], activePaneId: PID } },
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(Object.keys(v.panes)).toHaveLength(0);
    expect(v.groups.g1.paneIds).toEqual([]);
    expect((v.groups.g1 as { activePaneId?: string }).activePaneId).toBeUndefined();
  });

  it("drops the topic from a closedStack undo record", () => {
    const v = {
      panes: {},
      groups: {},
      closedStack: [
        { id: "r1", pane: { id: TID, type: "chat", topicId: TID } },
        { id: "r2", pane: { id: "terminal:x", type: "terminal" } },
      ],
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(v.closedStack.map((r) => r.id)).toEqual(["r2"]);
  });

  it("removes the topic from the legacy/project openChatTopicIds shape", () => {
    const v = {
      nonChatPanes: [{ id: "terminal:x", type: "terminal" }],
      openChatTopicIds: ["other", TID],
      activeChatTopicId: TID,
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(v.openChatTopicIds).toEqual(["other"]);
    expect((v as { activeChatTopicId?: string }).activeChatTopicId).toBeUndefined();
    expect(v.nonChatPanes).toHaveLength(1); // non-chat panes untouched
  });

  it("leaves a durable tombstone for every pane it removed", () => {
    // Without this the purge is UNDONE by the client: HYDRATE_FROM_SNAPSHOT
    // unions local panes with the incoming snapshot and only drops the ones
    // carrying a close marker, so a bare deletion resurrects on the next PUT.
    const PID = `chat:${TID}`;
    const v: any = {
      panes: {
        [TID]: { id: TID, type: "chat", topicId: TID },
        [PID]: { id: PID, type: "chat", topicId: TID },
        "project:%2Ffoo": { id: "project:%2Ffoo", type: "project" },
      },
      groups: { "group:default": { id: "group:default", paneIds: [TID, PID, "project:%2Ffoo"] } },
      closedStack: [],
    };
    const before = Date.now();
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(Object.keys(v.tombstones).sort()).toEqual([PID, TID].sort());
    expect(v.tombstones[TID]).toBeGreaterThanOrEqual(before);
    expect(v.tombstones["project:%2Ffoo"]).toBeUndefined(); // bystander untouched
  });

  it("merges into a pre-existing tombstone map and caps it at 500", () => {
    const v: any = {
      panes: { [TID]: { id: TID, type: "chat", topicId: TID } },
      groups: {},
      tombstones: Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [`old:${i}`, 1_000 + i]),
      ),
    };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    const ids = Object.keys(v.tombstones);
    expect(ids).toHaveLength(500);
    expect(v.tombstones[TID]).toBeDefined();   // the fresh marker survives
    expect(v.tombstones["old:0"]).toBeUndefined(); // the oldest is evicted
    expect(v.tombstones["old:499"]).toBe(1_499);   // recent ones are kept
  });

  it("writes no tombstone when the record holds no pane for the topic", () => {
    // Shape-A-only records (project openChatTopicIds) have no `panes` map — a
    // tombstone there would be meaningless noise on the wire.
    const v: any = { openChatTopicIds: ["other", TID] };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(v.tombstones).toBeUndefined();
  });

  it("is a no-op (returns false) when the topic is absent", () => {
    const v = {
      panes: { "project:%2Ffoo": { id: "project:%2Ffoo", type: "project" } },
      groups: { "group:default": { id: "group:default", paneIds: ["project:%2Ffoo"] } },
      openChatTopicIds: ["someone-else"],
    };
    const snapshot = JSON.stringify(v);
    expect(removeTopicFromUiStateValue(v, TID)).toBe(false);
    expect(JSON.stringify(v)).toBe(snapshot); // unchanged
  });

  it("returns false for non-object / array inputs", () => {
    expect(removeTopicFromUiStateValue(null, TID)).toBe(false);
    expect(removeTopicFromUiStateValue("x", TID)).toBe(false);
    expect(removeTopicFromUiStateValue([1, 2], TID)).toBe(false);
  });
});

/**
 * The inverse half. Stamping a marker on archive without retracting it on
 * unarchive makes the reopen INVISIBLE: the client's hydrate runs a
 * bidirectional tombstone strip that deletes any pane whose id is tombstoned,
 * even when the incoming snapshot lists it — so the chat comes back in the
 * topic list but its tab is stripped on every load.
 */
describe("retractTopicTombstoneFromUiStateValue", () => {
  const TID = "d16d99fa-e2ca-4a6a-a201-63a205dd9eda";

  it("round-trips with the purge: archive stamps, unarchive retracts", () => {
    const v: any = {
      panes: { [TID]: { id: TID, type: "chat", topicId: TID } },
      groups: { "group:default": { id: "group:default", paneIds: [TID] } },
    };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(v.tombstones[TID]).toBeDefined();
    expect(retractTopicTombstoneFromUiStateValue(v, TID)).toBe(true);
    expect(v.tombstones[TID]).toBeUndefined();
  });

  it("retracts the prefixed pane-id encoding too, leaving bystanders alone", () => {
    const OTHER = "b0000000-0000-4000-8000-000000000000";
    const v: any = {
      tombstones: {
        [TID]: 111,
        [`chat:${TID}`]: 222,
        [OTHER]: 333,
        "terminal:xyz": 444,
      },
    };
    expect(retractTopicTombstoneFromUiStateValue(v, TID)).toBe(true);
    expect(Object.keys(v.tombstones).sort()).toEqual([OTHER, "terminal:xyz"].sort());
  });

  it("is a no-op (false) with no tombstone map or no matching id", () => {
    expect(retractTopicTombstoneFromUiStateValue({ panes: {} }, TID)).toBe(false);
    expect(retractTopicTombstoneFromUiStateValue({ tombstones: { other: 1 } }, TID)).toBe(false);
    expect(retractTopicTombstoneFromUiStateValue(null, TID)).toBe(false);
    expect(retractTopicTombstoneFromUiStateValue([1, 2], TID)).toBe(false);
  });
});
