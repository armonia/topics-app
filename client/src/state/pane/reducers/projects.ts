import type { PaneState, PaneAction, ProjectLayout } from '../types';

export function projectsReducer(state: PaneState, action: PaneAction): void {
  switch (action.type) {
    case 'PROJECT_LAYOUT_SNAPSHOT': {
      const { projectPath } = action.payload;
      // Snapshot current visible state into projects[projectPath]
      const layout: ProjectLayout = {
        projectPath,
        groups: state.groupOrder
          .map((gid) => state.groups[gid])
          .filter((g): g is NonNullable<typeof g> => Boolean(g))
          .map((g) => ({ ...g, paneIds: [...g.paneIds] })),
        panes: { ...state.panes },
        groupOrder: [...state.groupOrder],
        tabOrder: state.groupOrder.flatMap((gid) => state.groups[gid]?.paneIds ?? []),
        focusedPaneId: state.focusedPaneId,
        lastOpenedAt: Date.now(),
      };
      state.projects[projectPath] = layout;
      break;
    }
    case 'PROJECT_LAYOUT_RESTORE': {
      const { layout } = action.payload;
      // Replace visible state with saved layout (atomic batch)
      state.groups = {};
      state.panes = { ...layout.panes };
      state.groupOrder = [...layout.groupOrder];
      for (const g of layout.groups) {
        state.groups[g.id] = { ...g, paneIds: [...g.paneIds] };
      }
      state.focusedPaneId = layout.focusedPaneId; // project-restore IS allowed to restore focus
      state.projects[layout.projectPath] = { ...layout, lastOpenedAt: Date.now() };
      break;
    }
  }
}
