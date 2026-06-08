import { describe, expect, it } from "bun:test";
import { removeTopicFromUiStateValue } from "./topics";

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
