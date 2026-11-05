/**
 * The small System pane (`__system__`, type `system`) is retired: a window
 * that saved it under an older version must load without it, with no ghost
 * tab and no empty cell where it stood.
 *
 * @covers HUBBR-04
 */
import { describe, expect, test } from "bun:test";
import { paneReducer } from "./panes";
import { sanitizeSnapshot } from "./sanitizeSnapshot";
import { isUtilityPanelType } from "../adapters/utilityPanelId";
import { PANE_TYPES, type PaneState } from "../types";

const blank = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId: "space:default",
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

// What an older version persisted: a chat, and the System pane in a split
// cell of its own beside it.
const SAVED = {
  panes: {
    "chat:t1": { id: "chat:t1", type: "chat", title: "Chat", topicId: "t1" },
    "__system__": { id: "__system__", type: "system", title: "Sistema" },
  },
  groups: {
    "group:default": { id: "group:default", paneIds: ["chat:t1"], splitRatio: 0.5, splitAxis: "horizontal" },
    "group:side": { id: "group:side", paneIds: ["__system__"], splitRatio: 0.5, splitAxis: "horizontal" },
  },
  groupOrder: ["group:default", "group:side"],
  closedStack: [],
  server_seq: 1,
};

describe("HUBBR-04: a saved System pane does not come back", () => {
  test("the pane kind is gone, from the store and from the utility door", () => {
    expect(PANE_TYPES as readonly string[]).not.toContain("system");
    expect(isUtilityPanelType("system")).toBe(false);
  });

  test("the sanitizer drops the pane and every group reference to it", () => {
    const clean = sanitizeSnapshot(SAVED)!;
    expect(clean.panes?.["__system__"]).toBeUndefined();
    expect(clean.panes?.["chat:t1"]?.type).toBe("chat");
    for (const g of Object.values(clean.groups ?? {})) expect(g.paneIds).not.toContain("__system__");
  });

  test("hydrating the old snapshot leaves the chat and no tab of the System pane", () => {
    const s = blank();
    // Wire data from an older version: its `system` type is no PaneType any more.
    const snapshot = { ...SAVED, seq: 1 } as unknown as Partial<PaneState> & { seq: number; server_seq?: number };
    paneReducer(s, { type: "HYDRATE_FROM_SNAPSHOT", payload: { snapshot } });
    expect(Object.keys(s.panes)).toEqual(["chat:t1"]);
    const refs = Object.values(s.groups).flatMap((g) => g.paneIds);
    expect(refs).toEqual(["chat:t1"]);
  });
});
