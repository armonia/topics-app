import { useEffect, useRef, useState } from 'react';
import { AUTO_SHARE_CONFIRMATIONS, computeAutoShared, stepAutoShare, type AutoShareState } from '../lib/sharedAuto';

/** How often the viewer count is sampled. The confirmation below is counted in
 *  SAMPLES, so this number and the guard can never disagree the way a 1200ms
 *  timer over a 2000ms poll did. */
const POLL_MS = 2000;

/**
 * Decide, poll by poll, whether a desktop browser pane should render its private
 * native WKWebView or join the shared server session.
 *
 * The input is `GET /api/browsers/:id/viewers`, how many devices are streaming
 * that context. A Tauri pane on the native path opens NO streaming WS, so the
 * count is exactly the number of OTHER devices (phone PWA / web) watching — the
 * trigger to auto-join. The arithmetic of that reading is `computeAutoShared`;
 * how many readings it takes to move the pane is `stepAutoShare`.
 *
 * THE FOLD LIVES HERE, NOT IN THE CALLER, for two reasons and both are load
 * bearing:
 *
 *  - A caller can only see the count when it CHANGES: `setCount` with the same
 *    number bails out of the render, so an effect keyed on the count never runs
 *    twice in a row on a steady reading. Counting agreements out there would
 *    mean a pane that reaches one confirmation and waits forever for a second
 *    that cannot arrive — a phone watching, and a desktop that never joins.
 *  - Folding here also keeps the re-render where it belongs. The poll ticks
 *    every 2s per auto-mode pane; only a real FLIP reaches React.
 *
 * Polls only while `enabled` AND the tab is visible; disabled → no traffic and
 * the decision reads false. Network errors keep the last reading: a blip must
 * not feed the fold a number the server never sent.
 *
 * @param isVisible is this pane on screen, i.e. inside the server's count? A
 *   hidden shared pane reports `set_watching:false` and drops out, so it must
 *   not subtract itself (see `computeAutoShared`).
 */
export function useSharedViewerCount(contextId: string, enabled: boolean, isVisible = true): boolean {
  /** The decision, carrying the context it was made for: a pane reused for a
   *  different id must not answer with the previous one's side. Reset during
   *  render on the prop change (the pattern already used in RemoteBrowserPanel),
   *  not from inside the effect, where a synchronous setState would be a second
   *  render nobody asked for. */
  const [decided, setDecided] = useState<{ ctx: string; shared: boolean }>({ ctx: contextId, shared: false });
  if (decided.ctx !== contextId) setDecided({ ctx: contextId, shared: false });
  /** The fold's state between polls. A ref, so a steady reading costs no render. */
  const decision = useRef<AutoShareState>({ shared: false, agreeing: 0 });
  /** Read inside the poll closure, so `isVisible` changes need no re-subscribe.
   *  Written in an effect and not during render: a ref assigned while rendering
   *  is a value the next render may or may not have, which is exactly the kind
   *  of "sometimes" this hook exists to remove. */
  const visibleRef = useRef(isVisible);
  useEffect(() => { visibleRef.current = isVisible; }, [isVisible]);

  useEffect(() => {
    decision.current = { shared: false, agreeing: 0 };
    if (!enabled) return; // not polling → the pane stays on its native path
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;

    const fold = (count: number) => {
      const prev = decision.current;
      const next = stepAutoShare(prev, computeAutoShared(count, prev.shared, visibleRef.current));
      decision.current = next;
      if (next.shared !== prev.shared) setDecided({ ctx: contextId, shared: next.shared });
    };

    const poll = async () => {
      if (cancelled) return;
      // Skip the fetch while hidden (backgrounded tab) — resume on the next tick.
      // No fold either: a reading we did not take is not a reading that agrees.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      try {
        const res = await fetch(`/api/browsers/${encodeURIComponent(contextId)}/viewers`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          if (typeof data?.count === 'number') last = data.count;
          fold(last);
        }
      } catch {
        // Network blip — no fold. Feeding the streak a number the server never
        // sent is how a dead link would talk the pane into changing sides.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [contextId, enabled]);

  return enabled && decided.ctx === contextId ? decided.shared : false;
}

export { AUTO_SHARE_CONFIRMATIONS };
