import { useEffect, useRef, useState } from 'react';

/**
 * Poll how many devices are streaming a browser context's shared server session
 * (`GET /api/browsers/:id/viewers`). Drives cross-device auto-share on desktop:
 * a Tauri pane rendering its private native WKWebView opens NO streaming WS, so
 * the returned count is exactly the number of OTHER devices (phone PWA / web)
 * watching — the trigger to auto-join the shared session (see computeAutoShared).
 *
 * Polls only while `enabled` AND the tab is visible (an auto-mode desktop pane);
 * disabled → no traffic. ~2s cadence: the switch feels prompt without hammering
 * the server. Network errors keep the last count (a blip must not force a mode
 * flip). Returns the latest viewer count (0 when disabled).
 */
export function useSharedViewerCount(contextId: string, enabled: boolean): number {
  const [count, setCount] = useState(0);
  const countRef = useRef(0);

  useEffect(() => {
    if (!enabled) return; // not polling → the hook reports 0 (see return below)
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      // Skip the fetch while hidden (backgrounded tab) — resume on the next tick.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 2000);
        return;
      }
      try {
        const res = await fetch(`/api/browsers/${encodeURIComponent(contextId)}/viewers`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          const n = typeof data?.count === 'number' ? data.count : countRef.current;
          if (n !== countRef.current) { countRef.current = n; setCount(n); }
        }
      } catch {
        // Network blip — keep the last count (never flip mode on a transient error).
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    poll();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [contextId, enabled]);

  // Report 0 while disabled (no polling) without a synchronous in-effect reset.
  return enabled ? count : 0;
}
