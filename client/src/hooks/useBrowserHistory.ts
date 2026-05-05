import { useState, useCallback } from 'react';

/**
 * Phase 30 BROWSER-CHAT-04 — per-topic browser URL history persisted in
 * localStorage under key `browser-history-<topicId>`. Max 50 entries with
 * LRU + dedupe semantics: pushing an existing URL moves it to the front.
 */

const MAX_HISTORY = 50;

export function useBrowserHistory(topicId: string) {
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(`browser-history-${topicId}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });

  const push = useCallback(
    (url: string) => {
      if (!url || url === 'about:blank') return;
      setHistory(prev => {
        // Dedupe + LRU: remove existing entry, push to front, cap at MAX_HISTORY.
        const filtered = prev.filter(u => u !== url);
        const next = [url, ...filtered].slice(0, MAX_HISTORY);
        try {
          localStorage.setItem(`browser-history-${topicId}`, JSON.stringify(next));
        } catch {
          // Quota exceeded or storage disabled; the in-memory state still works.
        }
        return next;
      });
    },
    [topicId],
  );

  const clear = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(`browser-history-${topicId}`);
    } catch {
      // ignore
    }
  }, [topicId]);

  return { history, push, clear };
}
