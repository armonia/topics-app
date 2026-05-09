/**
 * useTerminalActivity — global terminal "in-progress" tracker.
 *
 * Each `<SingleTerminalPane>` dispatches a `terminal:activity` CustomEvent
 * on `window` for every WS data frame it receives (its pty's stdout
 * pulse). This hook subscribes to that stream and exposes a Set of
 * session ids that have fired in the last `idleMs` ms — i.e. the
 * "currently producing output" set.
 *
 * Pattern is intentionally client-only: no server change, no extra WS
 * channel, no polling. A terminal pane that's mounted (visible OR
 * keep-alived behind `display:none`) is already subscribed to its own
 * pty WS, so the activity signal is already flowing through the
 * renderer — we just re-broadcast a minimal pulse so non-pane consumers
 * (the tab bar, the sidebar) can react without subscribing to every
 * pty.
 *
 * Activity decay: when a session id fires, it joins the active set; a
 * timer is armed for `idleMs` (default 1500 ms) that drops the id back
 * out unless another pulse re-arms the timer. Tunable so different
 * UIs can feel snappier or stickier without sharing global state.
 */
import { useEffect, useRef, useState } from 'react';

const DEFAULT_IDLE_MS = 1_500;

export interface TerminalActivityEventDetail {
  sessionId?: string;
}

export function useTerminalActivity(idleMs: number = DEFAULT_IDLE_MS): Set<string> {
  const [active, setActive] = useState<Set<string>>(() => new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<TerminalActivityEventDetail>).detail;
      const id = detail?.sessionId;
      if (!id) return;

      // Mark active. `Set` identity changes only when we actually add a
      // new id — no spurious re-renders for repeated pulses.
      setActive((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });

      // Re-arm the per-id idle timer.
      const existingTimer = timersRef.current.get(id);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setActive((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, idleMs);
      timersRef.current.set(id, timer);
    };

    window.addEventListener('terminal:activity', handler as EventListener);
    return () => {
      window.removeEventListener('terminal:activity', handler as EventListener);
      // Clear pending decay timers on unmount so we don't fire setState
      // on an unmounted hook holder.
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [idleMs]);

  return active;
}
