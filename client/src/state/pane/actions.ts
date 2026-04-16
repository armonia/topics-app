import type { Pane, PaneAction, ProjectLayout } from './types';

export const openPane = (
  p: Pane & { groupId: string; insertIndex?: number },
): PaneAction => ({ type: 'OPEN_PANE', payload: p });

export const closePane = (p: {
  id: string;
  groupId: string;
  groupIndex: number;
}): PaneAction => ({ type: 'CLOSE_PANE', payload: p });

export const undoClose = (): PaneAction => ({ type: 'UNDO_CLOSE' });

export const focusPane = (id: string | null): PaneAction => ({
  type: 'FOCUS_PANE',
  payload: { id },
});

export const splitGroup = (p: {
  groupId: string;
  axis: 'horizontal' | 'vertical';
  ratio: number;
}): PaneAction => ({ type: 'SPLIT', payload: p });

export const resizeGroup = (p: { groupId: string; ratio: number }): PaneAction => ({
  type: 'RESIZE',
  payload: p,
});

export const reorderPanes = (p: { groupId: string; paneIds: string[] }): PaneAction => ({
  type: 'REORDER_PANES',
  payload: p,
});

export const projectLayoutRestore = (
  projectPath: string,
  layout: ProjectLayout,
): PaneAction => ({
  type: 'PROJECT_LAYOUT_RESTORE',
  payload: { projectPath, layout },
});

export const projectLayoutSnapshot = (projectPath: string): PaneAction => ({
  type: 'PROJECT_LAYOUT_SNAPSHOT',
  payload: { projectPath },
});

export const paneIdRemap = (from: string, to: string): PaneAction => ({
  type: 'PANE_ID_REMAP',
  payload: { from, to },
});

export const clearClosedRecord = (id: string): PaneAction => ({
  type: 'CLEAR_CLOSED_RECORD',
  payload: { id },
});

export const clearClosedStack = (): PaneAction => ({ type: 'CLEAR_CLOSED_STACK' });
