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
  const closedTabs = safeJSON<unknown[]>('topics-closed-tabs', []);
  const gridLayout = safeJSON<unknown>('topics-grid-layout', null);
  const projectLayout = safeJSON<unknown>('topics-project-layout', null);

  usePaneStore.getState().dispatch({
    type: 'HYDRATE_FROM_LEGACY',
    payload: { openPanels, focusedPaneId, panelOrder, closedTabs, gridLayout, projectLayout },
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
