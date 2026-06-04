/**
 * projectFocus — the active INNER pane of each open project window.
 *
 * A project pane (`project:<path>`) is a single App-level pane, but it hosts its
 * own ProjectWindow with inner tabs (chats, terminals, browsers). When you focus
 * a child inside a project, the App-level focusedPanelId stays the project pane,
 * so the sidebar (which follows focusedPanelId) could only light the project
 * FOLDER — never the child you're actually in. `projectActiveTopics` only covered
 * chats; terminals/browsers were invisible.
 *
 * Each mounted ProjectWindow reports its focused group's active pane id here
 * (any type). The sidebar reads it to light the matching child row of the
 * focused project — so "selected" follows the real inner tab, not just the
 * folder. Lightweight standalone store on purpose: keeps this off the hot
 * App.tsx ⇄ usePanelLifecycle plumbing path.
 */
import { create } from 'zustand';

interface ProjectFocusState {
  /** projectPath → the focused inner group's active pane id (`chat:<id>` /
   *  `terminal:<id>` / `browser:<id>` / …), or null. */
  activePaneByProject: Record<string, string | null>;
  setActivePane: (projectPath: string, paneId: string | null) => void;
}

export const useProjectFocusStore = create<ProjectFocusState>((set) => ({
  activePaneByProject: {},
  setActivePane: (projectPath, paneId) =>
    set((s) =>
      s.activePaneByProject[projectPath] === paneId
        ? s
        : { activePaneByProject: { ...s.activePaneByProject, [projectPath]: paneId } },
    ),
}));

/** Stable setter for effects (no hook subscription). */
export const projectFocusActions = {
  setActivePane: (projectPath: string, paneId: string | null) =>
    useProjectFocusStore.getState().setActivePane(projectPath, paneId),
};
