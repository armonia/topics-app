import { useSyncExternalStore } from 'react';

/**
 * The reader's choice for JSON tool results: the readable layout or the
 * original coloured text (remembered). Kept in localStorage: it is a
 * per-browser display preference, not data. The fallback switch and its model
 * are NOT here: they are server settings (`readable_view_settings`).
 */
export type ReadableMode = 'readable' | 'original';
export interface ReadableViewPrefs { mode: ReadableMode }

const KEY = 'topics.readableView';
const DEFAULTS: ReadableViewPrefs = { mode: 'readable' };

const listeners = new Set<() => void>();
let cached: ReadableViewPrefs | null = null;

function load(): ReadableViewPrefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<ReadableViewPrefs>;
    return { mode: p.mode === 'original' ? 'original' : 'readable' };
  } catch {
    return DEFAULTS;
  }
}

export function getReadableViewPrefs(): ReadableViewPrefs {
  if (!cached) cached = load();
  return cached;
}

export function setReadableViewPrefs(patch: Partial<ReadableViewPrefs>): void {
  cached = { ...getReadableViewPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* private mode: the choice lasts for this page only */ }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function useReadableViewPrefs(): ReadableViewPrefs {
  return useSyncExternalStore(subscribe, getReadableViewPrefs, getReadableViewPrefs);
}
