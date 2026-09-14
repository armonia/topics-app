/**
 * RECLAIM_PANE: a page LEAVES the layout because something else is showing it.
 *
 * The topic's browser window and the layout can both draw the same contextId,
 * and exactly one of them may do it at a time: two panels on one native view
 * fight over `set_bounds`, and the person sees a page that flickers between
 * two boxes. Taking the page back with CLOSE_PANE looked right and was not:
 * closing pushes an undo record, so Cmd+Shift+T re-opened the page the window
 * had just taken home. Hence an action of its own, with the tombstone (a stale
 * peer must not resurrect the pane) and without the undo record.
 *
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { usePaneStore } from "./store";
import { DEFAULT_SPACE_ID } from "./types";

function resetStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    closedStack: [],
    focusedPaneId: null,
    groupOrder: [],
    spaces: {},
    activeSpaceId: DEFAULT_SPACE_ID,
    lastSeq: 0,
    lastServerSeq: 0,
  });
}

const PANE = "browser:ctx-1";

function openBrowserPane(): void {
  usePaneStore.getState().dispatch({
    type: "OPEN_PANE",
    payload: { id: PANE, type: "browser", title: "A page", groupId: "g1" },
  });
}

describe("RECLAIM_PANE (the window takes its page back)", () => {
  beforeEach(resetStore);

  test("removes the pane from the layout", () => {
    openBrowserPane();
    usePaneStore.getState().dispatch({ type: "RECLAIM_PANE", payload: { id: PANE } });

    const state = usePaneStore.getState();
    expect(state.panes[PANE]).toBeUndefined();
    expect(Object.values(state.groups).some((g) => g.paneIds.includes(PANE))).toBe(false);
  });

  test("leaves NO undo record: Cmd+Shift+T cannot re-open a page the window is showing", () => {
    openBrowserPane();
    usePaneStore.getState().dispatch({ type: "RECLAIM_PANE", payload: { id: PANE } });

    expect(usePaneStore.getState().closedStack.some((c) => c.pane.id === PANE)).toBe(false);
  });

  test("CLOSE_PANE, by contrast, does leave one (that is the bug it replaces)", () => {
    openBrowserPane();
    const at = usePaneStore.getState().groups.g1 ? { groupId: "g1", groupIndex: 0 } : { groupId: "g1", groupIndex: 0 };
    usePaneStore.getState().dispatch({ type: "CLOSE_PANE", payload: { id: PANE, ...at } });

    expect(usePaneStore.getState().closedStack.some((c) => c.pane.id === PANE)).toBe(true);
  });

  test("writes the tombstone, so a late frame from another tab cannot bring it back", () => {
    openBrowserPane();
    usePaneStore.getState().dispatch({ type: "RECLAIM_PANE", payload: { id: PANE } });

    expect(usePaneStore.getState().tombstones?.[PANE]).toBeDefined();
  });

  test("promoting the same page again is still allowed: OPEN_PANE clears the tombstone", () => {
    openBrowserPane();
    usePaneStore.getState().dispatch({ type: "RECLAIM_PANE", payload: { id: PANE } });
    openBrowserPane();

    expect(usePaneStore.getState().panes[PANE]).toBeDefined();
    expect(usePaneStore.getState().tombstones?.[PANE]).toBeUndefined();
  });

  test("an id nobody holds leaves the layout alone (no tombstone for a ghost)", () => {
    openBrowserPane();
    usePaneStore.getState().dispatch({ type: "RECLAIM_PANE", payload: { id: "browser:nope" } });

    expect(usePaneStore.getState().panes[PANE]).toBeDefined();
    expect(usePaneStore.getState().tombstones?.["browser:nope"]).toBeUndefined();
  });
});
