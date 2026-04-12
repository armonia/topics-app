import { useState, useCallback, useRef } from 'react';
import type { ClosedTabRecord } from '../lib/closedTabRecord';

const MAX_CLOSED_TABS = 20;
const STORAGE_KEY = 'topics-closed-tabs';

function loadFromStorage(): ClosedTabRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const records = JSON.parse(raw) as ClosedTabRecord[];
    // Strip non-serializable fields (timers)
    return records.map(r => ({ ...r, _cleanupTimer: undefined }));
  } catch { return []; }
}

function saveToStorage(records: ClosedTabRecord[]) {
  try {
    // Strip non-serializable fields before saving
    const clean = records.map(({ _cleanupTimer, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch { /* quota exceeded or private mode */ }
}

/**
 * Stack of recently closed tabs, persisted to localStorage.
 * Used by both the "Reopen Closed Tab" (Cmd+Shift+T) and the undo system.
 */
export function useClosedTabs() {
  const [closedTabs, setClosedTabs] = useState<ClosedTabRecord[]>(loadFromStorage);
  const closedTabsRef = useRef(closedTabs);
  closedTabsRef.current = closedTabs;

  const pushClosedTab = useCallback((record: ClosedTabRecord) => {
    setClosedTabs(prev => {
      const next = [record, ...prev].slice(0, MAX_CLOSED_TABS);
      saveToStorage(next);
      return next;
    });
  }, []);

  const popClosedTab = useCallback((): ClosedTabRecord | undefined => {
    let popped: ClosedTabRecord | undefined;
    setClosedTabs(prev => {
      if (prev.length === 0) return prev;
      popped = prev[0];
      const next = prev.slice(1);
      saveToStorage(next);
      return next;
    });
    // Return from ref since setState is async
    const current = closedTabsRef.current;
    return current.length > 0 ? current[0] : undefined;
  }, []);

  const removeClosedTab = useCallback((recordId: string) => {
    setClosedTabs(prev => {
      const next = prev.filter(r => r.id !== recordId);
      if (next.length === prev.length) return prev;
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearClosedTabs = useCallback(() => {
    // Cancel any pending cleanup timers
    closedTabsRef.current.forEach(r => {
      if (r._cleanupTimer) clearTimeout(r._cleanupTimer);
    });
    setClosedTabs([]);
    saveToStorage([]);
  }, []);

  return {
    closedTabs,
    pushClosedTab,
    popClosedTab,
    removeClosedTab,
    clearClosedTabs,
  };
}
