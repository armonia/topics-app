/**
 * The title of a split cell as a handle (SPLIT-03): its lit edge and its drag.
 * Kept apart from CellHeader.tsx so that file exports components only.
 */
import type React from 'react';
import { DND_TYPES, STANDALONE_SCOPE, paneTabScopeType } from '../../lib/dndTypes';
import { rememberDraggedPane } from '../../lib/dragPayload';
import { startDragPreview } from '../../lib/dragPreview';
import { paneZoomActions } from '../../state/paneZoom';

/** The lit edge of the cell with the focus: an inset line under its title, so
 *  the bar keeps its height and nothing moves when the focus changes. */
export const FOCUSED_CELL_EDGE: React.CSSProperties = { boxShadow: 'inset 0 -2px 0 var(--primary)' };

/**
 * Drag the cell's title exactly like the tab of the pane in front: the same
 * payload a top-level tab carries, so the grid lands it with the same rules
 * (edges split, centre merges) and draws the same footprint.
 */
export function startCellTitleDrag(
  e: React.DragEvent,
  pane: { id: string; type: string; topicId?: string },
  cellKey: string,
  title: string,
  zoomed: boolean,
): void {
  // A drag reorganises the grid: the zoom goes first, so the targets it
  // offers are on screen (same rule as PaneTabBar).
  if (zoomed) paneZoomActions.exitTop();
  e.dataTransfer.setData(DND_TYPES.PANE_TAB, pane.id);
  e.dataTransfer.setData(DND_TYPES.PANE_TAB_GROUP, cellKey);
  e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.type === 'chat' && pane.topicId ? pane.topicId : pane.id);
  e.dataTransfer.setData(paneTabScopeType(STANDALONE_SCOPE), '1');
  e.dataTransfer.setData(DND_TYPES.PANE_TAB_SCOPE, STANDALONE_SCOPE);
  e.dataTransfer.effectAllowed = 'move';
  rememberDraggedPane(pane.id);
  startDragPreview(e, { title });
}
