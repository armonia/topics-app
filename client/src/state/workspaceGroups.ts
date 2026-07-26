/**
 * workspaceGroups — a read-only mirror of the groups (cells) the standalone
 * workspace is currently rendering in THIS window.
 *
 * WHY A MIRROR: the group composition lives in PanelGrid's local state
 * (`naturalGridItems`, derived from openPanels + the local `soloCells`), which
 * the sidebar — an App.tsx sibling — cannot reach. Rather than lift that state
 * (PanelGrid's DnD/split plumbing is deliberately self-contained), PanelGrid
 * PUBLISHES its composition here after each commit and the sidebar SUBSCRIBES.
 * Strictly one-directional: nothing here ever writes back into the layout, so
 * the drag/split paths keep their single source of truth.
 *
 * EPHEMERAL and DEVICE-LOCAL — never persisted, never synced. It describes what
 * this window is showing right now, exactly like windowPresence describes what
 * every window is holding right now (same lightweight standalone-store shape).
 */
import { create } from 'zustand';

export interface WorkspaceGroup {
  /** Grid item key: 'standalone' for the main pool, `solo:<primary>` for a split cell. */
  key: string;
  /** Ordered pane/topic ids in this group (tab order). */
  paneIds: string[];
}

interface WorkspaceGroupsState {
  groups: WorkspaceGroup[];
}

export const useWorkspaceGroupsStore = create<WorkspaceGroupsState>(() => ({
  groups: [],
}));

/** True when the two compositions are identical (same cells, same order). */
function sameGroups(a: WorkspaceGroup[], b: WorkspaceGroup[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => {
    const o = b[i];
    return (
      o.key === g.key &&
      o.paneIds.length === g.paneIds.length &&
      o.paneIds.every((id, j) => id === g.paneIds[j])
    );
  });
}

/**
 * Publish the current composition. No-ops when nothing changed — PanelGrid
 * re-derives `naturalGridItems` on every openPanels/soloCells change, and an
 * unconditional set() would re-render every subscriber on identical data.
 */
export function publishWorkspaceGroups(groups: WorkspaceGroup[]): void {
  if (sameGroups(useWorkspaceGroupsStore.getState().groups, groups)) return;
  useWorkspaceGroupsStore.setState({ groups });
}

/** Subscribe to the live composition. */
export function useWorkspaceGroups(): WorkspaceGroup[] {
  return useWorkspaceGroupsStore((s) => s.groups);
}
