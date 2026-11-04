/**
 * The System pane (usage hub) as a PANE KIND: `system`, the utility id
 * `__system__`, registered like Dashboard and Board (state/pane/types.ts,
 * adapters/utilityPanelId.ts). On the desktop it opens as one more split cell
 * beside the work, through the same `topics:open-utility` door every utility
 * pane uses (usePanelLifecycle decides the split), so it is resizable like any
 * cell and survives a reload with the pane store. «Open full view» is the
 * grid's own zoom on that cell.
 *
 * On the phone the grid draws no splits, so the same content opens in the
 * bottom sheet instead; that sheet is device-local state, kept here.
 */
import { useSyncExternalStore } from 'react';
import { usePaneStore } from './pane/store';
import { utilityPanelId } from './pane/adapters/utilityPanelId';
import { paneZoomActions, usePaneZoomStore, STANDALONE_ZOOM_SURFACE_ID } from './paneZoom';

export const SYSTEM_PANE_ID = utilityPanelId('system');

/** Open the System pane: a split cell beside the work, or the sheet on the phone. */
export function openSystemPane(): void {
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'system' } }));
}

/** Whether the pane is open in this window's grid. */
export function useSystemPaneOpen(): boolean {
  return usePaneStore((s) => s.panes[SYSTEM_PANE_ID] !== undefined);
}

/** Whether the grid's zoom shows the System cell alone («open full view»). */
export function useSystemPaneMaximized(): boolean {
  return usePaneZoomStore((s) => s.bySurface[STANDALONE_ZOOM_SURFACE_ID]?.anchorPaneId === SYSTEM_PANE_ID);
}

/** «Open full view» and back: the same zoom as a double click on the tab. */
export function toggleSystemPaneMaximized(): void {
  paneZoomActions.toggle(STANDALONE_ZOOM_SURFACE_ID, SYSTEM_PANE_ID, 'cell');
}

// ── The phone sheet ──────────────────────────────────────────────────────────

let sheetOpen = false;
const listeners = new Set<() => void>();

function setSheet(next: boolean): void {
  if (next === sheetOpen) return;
  sheetOpen = next;
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useSystemSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, () => sheetOpen, () => sheetOpen);
}

export function openSystemSheet(): void {
  setSheet(true);
}

export function closeSystemSheet(): void {
  setSheet(false);
}

/** Test seam: the sheet state without React. */
export const _readSystemSheetForTests = (): boolean => sheetOpen;
