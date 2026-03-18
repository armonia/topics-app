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
 * Hook for state backed by server /api/ui-state/:key.
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
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(key)}`)
      .then(r => r.ok ? r.json() : null)
      .then(serverValue => {
        if (!mountedRef.current || serverValue === null || serverValue === undefined) return;
        isFromServerRef.current = true;
        setValueRaw(serverValue);
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
        setValueRaw(msg.value);
        if (localStorageKey) {
          try { localStorage.setItem(localStorageKey, JSON.stringify(msg.value)); } catch {}
        }
      }
      if (msg.type === 'ui-state:init' && msg.data && key in msg.data) {
        isFromServerRef.current = true;
        setValueRaw(msg.data[key]);
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
      fetch(`/api/ui-state/${encodeURIComponent(key)}`, {
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
