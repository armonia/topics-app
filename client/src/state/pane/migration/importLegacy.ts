import { usePaneStore } from '../store';

const LEGACY_KEYS = [
  'topics-open-panels',
  'topics-focused-panel',
  'topics-panel-order',
  'topics-closed-tabs',
  'topics-grid-layout',
  'topics-project-layout',
] as const;

function safeJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function hydrateFromLegacyStorage(): void {
  if (typeof localStorage === 'undefined') return;

  const openPanels = safeJSON<string[]>('topics-open-panels', []);
  const focusedPaneId = localStorage.getItem('topics-focused-panel');
  const panelOrder = safeJSON<{ order: string[]; pinned: string[] }>('topics-panel-order', {
    order: [],
    pinned: [],
  });
  // topics-closed-tabs / topics-grid-layout / topics-project-layout used to be
  // read here too, but the HYDRATE_FROM_LEGACY reducer case (panes.ts) only
  // ever destructured openPanels/focusedPaneId/panelOrder — those three were
  // read, dispatched, and then immediately deleted below with the rest of
  // LEGACY_KEYS, never reaching any consumer. Dropped rather than wired up
  // (that would be a new migration feature, not a dead-code removal).

  usePaneStore.getState().dispatch({
    type: 'HYDRATE_FROM_LEGACY',
    payload: { openPanels, focusedPaneId, panelOrder },
  });

  for (const k of LEGACY_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}
