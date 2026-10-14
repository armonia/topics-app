/**
 * How this device shows a page the Mac hosts (BROWSER-DOM-LAYOUT-01).
 *
 * 'own': its copy is laid out at its own size and the Mac keeps its own, the
 * default since 14/10 ("the last browser I open resizes the other"). 'page':
 * the Mac's page takes this device's size while it is used here
 * (TOPIC-BROWSER-05), for a site whose scripts lay it out for one width and
 * look wrong at another. Per device, kept across reloads, in `localStorage`:
 * the choice is about this screen, not about the page.
 */
import { useSyncExternalStore } from 'react';

export type BrowserLayout = 'own' | 'page';

const KEY = 'topics-browser-layout';
const listeners = new Set<() => void>();
let current: BrowserLayout | null = null;

export function readBrowserLayout(): BrowserLayout {
  if (current) return current;
  try {
    current = localStorage.getItem(KEY) === 'page' ? 'page' : 'own';
  } catch {
    current = 'own';
  }
  return current;
}

export function setBrowserLayout(layout: BrowserLayout): void {
  current = layout;
  try {
    localStorage.setItem(KEY, layout);
  } catch { /* storage off: the choice lasts until the reload */ }
  for (const fn of [...listeners]) fn();
}

export function subscribeBrowserLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useBrowserLayout(): BrowserLayout {
  return useSyncExternalStore(subscribeBrowserLayout, readBrowserLayout, () => 'own');
}
