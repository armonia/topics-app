/**
 * WHICH TAB SHEET IS OPEN, AND FROM WHICH DOOR (TABSHEET-01).
 *
 * A tab has one command surface, its sheet, and the app shows one sheet at a
 * time: a right click on another tab closes this one and opens that one. The
 * rule needs a single owner, because the doors are scattered. The tab strip
 * opens a sheet on a right click, a long press or Shift+F10; a browser pane
 * asks for its own on Cmd+L, on a click on its active tab or on its downloads
 * cue (`state/browserPaneChrome` counters); the phone title asks for the sheet
 * of the surface in front. They all write here, and every mounted sheet reads
 * whether it is the open one.
 *
 * The key is whatever the surface calls the tab: a pane id for the tab strip
 * and the topic window, `title:<paneId>` for the phone title (the same pane
 * can be mounted under both).
 *
 * THE DOOR THAT CLOSES. A press on the tab of the open sheet (its label, its
 * dots, or a right click on it) closes the sheet, and the request that the
 * same gesture produces a moment later (the click, the `contextmenu`) must not
 * open it again. `swallowNextOpen` marks that key until the NEXT gesture
 * starts: a press that produced no request (a drag) must not eat a later one.
 */
import { useSyncExternalStore } from 'react';

/** How a sheet was asked for: it decides where the focus lands. */
export type TabSheetDoor = 'address' | 'downloads' | 'commands';

export interface OpenTabSheet {
  key: string;
  door: TabSheetDoor;
  /** Grows on every opening, so a re-request of the same key re-seeds it. */
  seq: number;
}

let current: OpenTabSheet | null = null;
let seq = 0;
let swallowKey: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Opens the sheet of `key`, closing whichever other one is open. */
export function openTabSheet(key: string, door: TabSheetDoor): void {
  if (swallowKey === key) {
    swallowKey = null;
    return;
  }
  seq += 1;
  current = { key, door, seq };
  emit();
}

/** Closes the open sheet, or only the sheet of `key` when one is named. */
export function closeTabSheet(key?: string): void {
  if (!current || (key !== undefined && current.key !== key)) return;
  current = null;
  emit();
}

/** A right click on the tab whose sheet is open: close it, now. */
export function toggleTabSheet(key: string, door: TabSheetDoor): void {
  if (current?.key === key) closeTabSheet(key);
  else openTabSheet(key, door);
}

/**
 * The next request for `key` is the second half of the press that just closed
 * it, and is dropped. Disarmed by the next gesture that starts anywhere.
 */
export function swallowNextOpen(key: string, host: Pick<Document, 'addEventListener' | 'removeEventListener'> | null = typeof document === 'undefined' ? null : document, closing?: Event): void {
  swallowKey = key;
  if (!host) return;
  const disarm = (e: Event) => {
    // The press that armed this is still being dispatched: it is not the next one.
    if (e === closing) return;
    host.removeEventListener('pointerdown', disarm, true);
    host.removeEventListener('keydown', disarm, true);
    if (swallowKey === key) swallowKey = null;
  };
  host.addEventListener('pointerdown', disarm, true);
  host.addEventListener('keydown', disarm, true);
}

export function getOpenTabSheet(): OpenTabSheet | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The open sheet when it is the one of `key`, otherwise null. */
export function useOpenTabSheet(key: string): OpenTabSheet | null {
  return useSyncExternalStore(
    subscribe,
    () => (current?.key === key ? current : null),
    () => null,
  );
}

/** Test hook. */
export function __resetTabSheet(): void {
  current = null;
  swallowKey = null;
  seq = 0;
  listeners.clear();
}
