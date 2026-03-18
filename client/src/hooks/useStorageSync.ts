import { useEffect } from 'react';

/**
 * Cross-tab localStorage sync via storage events.
 * Fast-path for same-browser multi-tab (no server roundtrip).
 */
export function useStorageSync(key: string, onUpdate: (value: any) => void) {
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== key || !e.newValue) return;
      try { onUpdate(JSON.parse(e.newValue)); } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [key, onUpdate]);
}
