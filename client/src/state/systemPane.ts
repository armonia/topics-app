/**
 * Whether the System pane is open in this window, and whether it fills the
 * work area. Device-local on purpose: the pane sits BESIDE the work, it is not
 * one of the synced tabs (pane-store), so opening it on the phone does not
 * reshape the desktop and it never becomes a top-level tab.
 */
import { useSyncExternalStore } from 'react';

export interface SystemPaneState {
  open: boolean;
  maximized: boolean;
}

const CLOSED: SystemPaneState = { open: false, maximized: false };

let current: SystemPaneState = CLOSED;
const listeners = new Set<() => void>();

function set(next: SystemPaneState): void {
  if (next.open === current.open && next.maximized === current.maximized) return;
  current = next;
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useSystemPane(): SystemPaneState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Open beside the work (a second open keeps the current size). */
export function openSystemPane(): void {
  set({ open: true, maximized: current.open ? current.maximized : false });
}

export function closeSystemPane(): void {
  set(CLOSED);
}

/** The strip is a toggle: a click on it while open closes the pane. */
export function toggleSystemPane(): void {
  if (current.open) closeSystemPane();
  else openSystemPane();
}

/** "Open full view": the same pane over the whole work area, and back. */
export function toggleSystemPaneMaximized(): void {
  set({ open: true, maximized: !(current.open && current.maximized) });
}

/** Test seam: the state without React. */
export const _readSystemPaneForTests = (): SystemPaneState => current;
