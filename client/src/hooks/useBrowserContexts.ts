import { useState, useEffect, useCallback, useRef } from 'react';
import type { BrowserContextInfo } from '@/lib/buildSidebarItems';
import type { WSMessage } from '../types';

const POLL_INTERVAL_FALLBACK = 30_000; // 30s fallback

export function useBrowserContexts(
  enabled: boolean,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void
): {
  contexts: BrowserContextInfo[];
  closeContext: (id: string) => Promise<void>;
} {
  const [contexts, setContexts] = useState<BrowserContextInfo[]>([]);
  const lastUpdateRef = useRef<number>(0);

  const loadContexts = useCallback(async () => {
    try {
      const fetchTime = Date.now();
      const resp = await fetch('/api/browser/status');
      if (resp.ok) {
        if (lastUpdateRef.current > fetchTime) return;
        lastUpdateRef.current = fetchTime;
        const data = await resp.json();
        setContexts(data.details || []);
      }
    } catch {
      setContexts([]);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    if (!enabled) return;
    loadContexts();
  }, [enabled, loadContexts]);

  // WS subscription
  useEffect(() => {
    if (!enabled || !onMessage) return;
    return onMessage((msg: WSMessage) => {
      if (msg.type === 'browser:navigate') {
        lastUpdateRef.current = Date.now();
        loadContexts();
      }
    });
  }, [enabled, onMessage, loadContexts]);

  // Fallback polling
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(loadContexts, POLL_INTERVAL_FALLBACK);
    return () => clearInterval(interval);
  }, [enabled, loadContexts]);

  const closeContext = useCallback(async (id: string) => {
    try {
      await fetch(`/api/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setContexts(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('[BrowserContexts] Close failed:', err);
    }
  }, []);

  return { contexts, closeContext };
}
