import { useEffect, useRef } from 'react';
import type { WSMessage } from '../types';

export interface PanelOrderState {
  order: string[];
  pinned: string[];
}

const STORAGE_KEY = 'topics-panel-order';
const SERVER_KEY = 'panel-order';
const DEBOUNCE_MS = 1000;

/** Synchronous load from localStorage for fast-paint initialization */
export function loadPanelOrder(): PanelOrderState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { order: [], pinned: [] };
}

/**
 * Persistence side-effect hook for panel order + pinned state.
 * Does NOT manage state — just syncs what the consumer provides.
 *
 * - Saves to localStorage immediately on change
 * - Debounced PUT to /api/ui-state/panel-order
 * - Fetches from server on mount
 * - Listens for WS ui-state:init / ui-state:updated
 * - Cross-tab sync via storage events
 */
export function usePanelOrderPersistence(
  currentOrder: string[],
  currentPinned: string[],
  onExternalUpdate: (state: PanelOrderState) => void,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): void {
  const onExternalUpdateRef = useRef(onExternalUpdate);
  onExternalUpdateRef.current = onExternalUpdate;

  const orderRef = useRef(currentOrder);
  orderRef.current = currentOrder;

  const pinnedRef = useRef(currentPinned);
  pinnedRef.current = currentPinned;

  const isFromServerRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Fetch from server on mount
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`)
      .then(r => r.ok ? r.json() : null)
      .then(serverValue => {
        if (!mountedRef.current || serverValue === null || serverValue === undefined) return;
        const state = serverValue as PanelOrderState;
        if (state.order?.length || state.pinned?.length) {
          isFromServerRef.current = true;
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
          onExternalUpdateRef.current(state);
        }
      })
      .catch(() => {});
  }, []);

  // WS listener
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      let state: PanelOrderState | null = null;

      if (msg.type === 'ui-state:updated' && msg.key === SERVER_KEY) {
        state = msg.value as PanelOrderState;
      } else if (msg.type === 'ui-state:init' && msg.data && SERVER_KEY in msg.data) {
        state = msg.data[SERVER_KEY] as PanelOrderState;
      }

      if (state) {
        isFromServerRef.current = true;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
        onExternalUpdateRef.current(state);
      }
    });
  }, [onMessage]);

  // Cross-tab sync via storage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        isFromServerRef.current = true;
        onExternalUpdateRef.current(JSON.parse(e.newValue));
      } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Persist on change: localStorage immediately, server debounced
  // Empty state IS valid state and must be persisted to avoid stale data on server
  useEffect(() => {
    if (isFromServerRef.current) {
      isFromServerRef.current = false;
      return;
    }

    const state: PanelOrderState = { order: currentOrder, pinned: currentPinned };

    // Write localStorage immediately
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}

    // Debounce server PUT
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [currentOrder, currentPinned]);
}
