/**
 * Shared DnD MIME type constants for native HTML5 drag-and-drop.
 * Prevents typos and makes the DnD system self-documenting.
 */
export const DND_TYPES = {
  /** Panel/topic ID — cross-window panel drag, sidebar-to-grid drops */
  PANEL_ID: 'application/x-panel-id',
  /** Sidebar topic reordering */
  SIDEBAR_REORDER: 'application/x-sidebar-reorder',
  /** Project group drag for reordering in PanelGrid */
  PROJECT_GROUP: 'application/x-project-group',
  /** Pane tab reordering within a group */
  PANE_TAB: 'application/x-pane-tab',
  /** Source group ID for cross-group tab drags */
  PANE_TAB_GROUP: 'application/x-pane-tab-group',
  /** Unified grid item reordering (utility, project, standalone) */
  GRID_ITEM: 'application/x-grid-item',
  /** Row reordering within GroupLayout */
  LAYOUT_ROW: 'application/x-layout-row',
  /** Row reordering within PanelGrid */
  GRID_ROW: 'application/x-grid-row',
} as const;

export type DndType = typeof DND_TYPES[keyof typeof DND_TYPES];
