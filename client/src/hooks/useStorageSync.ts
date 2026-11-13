import { useEffect } from 'react';

/**
 * Cross-tab localStorage sync via storage events.
 * Fast-path for same-browser multi-tab (no server roundtrip).
 */
export function useStorageSync<T = unknown>(key: string, onUpdate: (value: T) => void) {
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== key || !e.newValue) return;
      let value: T;
      try {
        value = JSON.parse(e.newValue) as T;
      } catch (err) {
        console.warn('[storage-sync] failed to parse stored value', err);
        return;
      }
      onUpdate(value);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [key, onUpdate]);
}
