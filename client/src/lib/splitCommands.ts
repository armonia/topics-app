/**
 * Layout commands that any sheet can give for a pane: split it toward a side,
 * even out the splits around it.
 *
 * They travel as window events because the sheet that offers them (a row of
 * the column, a tab, a cell title) does not hold the layout: the surface that
 * holds the pane does — the top-level grid or a project window — and only
 * that one acts. A pane nobody holds is ignored, except a chat the grid can
 * open first.
 */

export type SplitSide = 'right' | 'left' | 'down' | 'up';

export const SPLIT_PANE_EVENT = 'topics:split-pane';
export interface SplitPaneDetail { paneId: string; side: SplitSide }

export const EQUALIZE_SPLITS_EVENT = 'topics:equalize-splits';
export interface EqualizeSplitsDetail { paneId: string }

export function requestSplit(paneId: string, side: SplitSide): void {
  window.dispatchEvent(new CustomEvent<SplitPaneDetail>(SPLIT_PANE_EVENT, { detail: { paneId, side } }));
}

export function requestEqualize(paneId: string): void {
  window.dispatchEvent(new CustomEvent<EqualizeSplitsDetail>(EQUALIZE_SPLITS_EVENT, { detail: { paneId } }));
}

/** The drop zone a split side lands in. */
export function sideZone(side: SplitSide): 'right' | 'left' | 'bottom' | 'top' {
  return side === 'down' ? 'bottom' : side === 'up' ? 'top' : side;
}

/** Whether a project window holds the pane: then the command is its own, and
 *  the top-level grid leaves it alone. A chat row carries the bare topic id,
 *  the project window holds it as `chat:<id>` (GroupLayout `data-project-panes`). */
export function heldByProjectWindow(paneId: string): boolean {
  if (typeof document === 'undefined') return false;
  return [paneId, `chat:${paneId}`].some((id) => document.querySelector(`[data-project-panes~="${CSS.escape(id)}"]`));
}
