/**
 * A project pane survives the store-to-React reorder bridge instead of being
 * dropped by it.
 *
 * @covers LAYOUT-02
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { usePaneStore } from "../store";
import { DEFAULT_SPACE_ID } from "../types";

// Reset the singleton store between tests (module-level Zustand instance).
function resetStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    closedStack: [],
    tombstones: {},
    focusedPaneId: null,
    groupOrder: [],
    spaces: {},
    activeSpaceId: DEFAULT_SPACE_ID,
    lastSeq: 0,
    lastServerSeq: 0,
  });
}

// Regression for the `open_project`-from-a-terminal-tab bug ("il tool dice di
// farlo ma il progetto non compare"). The server splices the terminal into the
// project's membership and broadcasts `open-project`; the client's WS handler
// then adds the project pane. This mirrors what the store↔React bridge does:
//
//   Effect B (React→store) dispatches REORDER_PANES on group:default with the
//   new openPanels list. REORDER_PANES is a permutation primitive — it FILTERS
//   to ids that have a pane ENTITY (groups.ts orphan-ID guard). So a project
//   pane id that was only pushed into React openPanels (bare setOpenPanels)
//   WITHOUT an OPEN_PANE registration has no entity, gets dropped by
//   REORDER_PANES, and the next Effect A tick wipes it back out → the project
//   flashes and vanishes. Registering it first (ensurePaneRegistered →
//   OPEN_PANE) is the fix.
describe("open-project project pane survives the store↔React reorder bridge", () => {
  beforeEach(resetStore);

  const PROJECT_PANE_ID = "project:%2FUsers%2Fme%2FProjects%2Fdiscoteca";

  test("REORDER_PANES DROPS a project pane id that was never registered (the bug)", () => {
    // A standalone terminal already lives in group:default.
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "terminal:abc", type: "terminal", title: "Claude Code", groupId: "group:default" },
    });

    // Simulate the BARE setOpenPanels the buggy open-project handler did:
    // openPanels now includes the project pane id, but no OPEN_PANE ran for it,
    // so state.panes has no entity. Effect B pushes that list through
    // REORDER_PANES.
    usePaneStore.getState().dispatch({
      type: "REORDER_PANES",
      payload: { groupId: "group:default", paneIds: ["terminal:abc", PROJECT_PANE_ID] },
    });

    // The orphan-ID guard silently drops the unregistered project pane — this
    // is exactly why the project never appears.
    expect(usePaneStore.getState().groups["group:default"].paneIds).not.toContain(PROJECT_PANE_ID);
    expect(usePaneStore.getState().panes[PROJECT_PANE_ID]).toBeUndefined();
  });

  test("a REGISTERED project pane survives the same reorder (the fix)", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "terminal:abc", type: "terminal", title: "Claude Code", groupId: "group:default" },
    });

    // The fix: ensurePaneRegistered dispatches OPEN_PANE for the project pane
    // BEFORE the openPanels update, so the entity exists.
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: PROJECT_PANE_ID, type: "project", projectPath: "/Users/me/Projects/discoteca", groupId: "group:default" },
    });

    // Effect B's reorder now carries an id backed by a real entity.
    usePaneStore.getState().dispatch({
      type: "REORDER_PANES",
      payload: { groupId: "group:default", paneIds: ["terminal:abc", PROJECT_PANE_ID] },
    });

    // The project pane stays in the tab bar and keeps its entity — the project
    // window mounts and the moved terminal renders inside it.
    expect(usePaneStore.getState().groups["group:default"].paneIds).toContain(PROJECT_PANE_ID);
    expect(usePaneStore.getState().panes[PROJECT_PANE_ID]?.type).toBe("project");
  });

  test("registering a project pane already open is idempotent (open_project into an OPEN project — the move-while-already-open case)", () => {
    // Project already open (its pane exists).
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: PROJECT_PANE_ID, type: "project", projectPath: "/Users/me/Projects/discoteca", groupId: "group:default" },
    });

    // A second open_project (server re-broadcasts open-project) re-registers the
    // same id. It must NOT duplicate the pane nor its group membership — the
    // window stays put and only re-focuses.
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: PROJECT_PANE_ID, type: "project", projectPath: "/Users/me/Projects/discoteca", groupId: "group:default" },
    });

    const ids = usePaneStore.getState().groups["group:default"].paneIds;
    expect(ids.filter((id) => id === PROJECT_PANE_ID)).toHaveLength(1);
    // Still a single project entity, and a REORDER carrying it keeps it (it
    // never regresses to a ghost after the move-into-an-open-project path).
    usePaneStore.getState().dispatch({
      type: "REORDER_PANES",
      payload: { groupId: "group:default", paneIds: [PROJECT_PANE_ID] },
    });
    expect(usePaneStore.getState().groups["group:default"].paneIds).toEqual([PROJECT_PANE_ID]);
    expect(usePaneStore.getState().panes[PROJECT_PANE_ID]?.type).toBe("project");
  });
});
