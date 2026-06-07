import { useState, useEffect, useRef, useCallback } from 'react';
import type { WSMessage } from '../types';

interface UseServerStateOptions {
  /** localStorage key for fast-paint cache */
  localStorageKey?: string;
  /** Debounce ms for PUT calls (default 500) */
  debounceMs?: number;
  /** WS message handler registration */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

/**
 * Hook for state backed by server /api/ui-state/:key. // PANE-01-ALLOWED: generic hook — callers supply non-pane keys only (pane-store-v2 uses dedicated middleware, not this hook).
 * - Fast paint from localStorage
 * - Fetches from server on mount
 * - Listens for WS ui-state:init / ui-state:updated
 * - Debounced PUT on change
 */
export function useServerState<T>(
  key: string,
  defaultValue: T,
  options: UseServerStateOptions = {},
): [T, (value: T | ((prev: T) => T)) => void] {
  const { localStorageKey, debounceMs = 500, onMessage } = options;

  // Initialize from localStorage (fast paint) or default
  const [value, setValueRaw] = useState<T>(() => {
    if (localStorageKey) {
      try {
        const raw = localStorage.getItem(localStorageKey);
        if (raw !== null) return JSON.parse(raw);
      } catch {}
    }
    return defaultValue;
  });

  const valueRef = useRef(value);
  valueRef.current = value;

  // Track whether the change is from server (skip PUT)
  const isFromServerRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Fetch from server on mount
  // PANE-01-ALLOWED: generic non-pane ui-state key. The server
  // GET /api/ui-state/:key endpoint returns { value, payload_version, server_seq } // PANE-01-ALLOWED
  // as of migration 012; unwrap .value for the legacy consumer shape.
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(key)}`) // PANE-01-ALLOWED: generic non-pane key supplied by caller
      .then(r => r.ok ? r.json() : null)
      .then(envelope => {
        // PANE-01-ALLOWED: unwrap v2 envelope { value, payload_version, server_seq }
        const serverValue = envelope && typeof envelope === 'object' && 'value' in envelope ? (envelope as { value: unknown }).value : envelope;
        if (!mountedRef.current || serverValue === null || serverValue === undefined) return;
        isFromServerRef.current = true;
        setValueRaw(serverValue as T);
        if (localStorageKey) {
          try { localStorage.setItem(localStorageKey, JSON.stringify(serverValue)); } catch {}
        }
      })
      .catch(() => {});
  }, [key, localStorageKey]);

  // WS listener
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      if (msg.type === 'ui-state:updated' && msg.key === key) {
        isFromServerRef.current = true;
        // The server-side store is opaque to the type system; this hook is
        // typed generic on `T` per-key. Casting is the cost of having a
        // single dispatcher route every keyed value type through one
        // WSMessage variant — alternative is one variant per key.
        setValueRaw(msg.value as T);
        if (localStorageKey) {
          try { localStorage.setItem(localStorageKey, JSON.stringify(msg.value)); } catch {}
        }
      }
      if (msg.type === 'ui-state:init' && msg.data && key in msg.data) {
        isFromServerRef.current = true;
        setValueRaw(msg.data[key] as T);
        if (localStorageKey) {
          try { localStorage.setItem(localStorageKey, JSON.stringify(msg.data[key])); } catch {}
        }
      }
    });
  }, [key, localStorageKey, onMessage]);

  // Cross-tab sync via storage events (same browser, no server roundtrip)
  useEffect(() => {
    if (!localStorageKey) return;
    const handler = (e: StorageEvent) => {
      if (e.key !== localStorageKey || !e.newValue) return;
      try {
        isFromServerRef.current = true;
        setValueRaw(JSON.parse(e.newValue));
      } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [localStorageKey]);

  // Debounced PUT to server on local change
  useEffect(() => {
    if (isFromServerRef.current) {
      isFromServerRef.current = false;
      return;
    }

    // Write localStorage immediately
    if (localStorageKey) {
      try { localStorage.setItem(localStorageKey, JSON.stringify(value)); } catch {}
    }

    // Debounce server PUT
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      // PANE-01-ALLOWED: generic non-pane key (supplied by caller). Pane state uses dedicated middleware, not this hook.
      fetch(`/api/ui-state/${encodeURIComponent(key)}`, { // PANE-01-ALLOWED
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      }).catch(() => {});
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [value, key, localStorageKey, debounceMs]);

  const setValue = useCallback((updater: T | ((prev: T) => T)) => {
    setValueRaw(updater);
  }, []);

  return [value, setValue];
}
