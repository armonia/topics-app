/**
 * useClaudeSessionState — subscribes to `session:state` WS broadcasts and
 * exposes a Map<sessionKey, ClaudeSessionState>.
 *
 * Bootstrap: fetches `/api/claude-sessions` once on mount to populate the
 * cache with the server's snapshot. Subsequent updates arrive via WS and are
 * dedup-merged by `rev`.
 *
 * This hook is intentionally passive — it does not trigger toasts, badges,
 * or UI changes on its own. Consumers (badge logic, completion notifier,
 * master strip) opt in by reading the returned Map.
 *
 * Pattern matches useTabNotifications.tsx: the parent passes an
 * `onWSMessage(handler) => unsubscribe` thunk and the hook attaches its
 * handler once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeSessionState, WSMessage } from '../types';
import { subscribeLifecycle } from '../lib/wsFrameBus';
import { useRefMirror } from './useRefMirror';
import { useWSSubscription } from './useWSSubscription';

export interface UseClaudeSessionStateOptions {
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  /**
   * Optional override for the bootstrap fetch URL — useful in tests.
   */
  fetchUrl?: string;
}

export interface UseClaudeSessionStateResult {
  /** Map keyed by `sessionKey` (Topics session id). */
  sessions: ReadonlyMap<string, ClaudeSessionState>;
  /** Convenience: look up by claudeSessionId. */
  getByClaudeSessionId: (id: string) => ClaudeSessionState | undefined;
  /** True once the initial snapshot has been applied. */
  hydrated: boolean;
}

/**
 * Merge one incoming session state into `prev`, honoring the rev/phase
 * monotonicity guard: a frame whose rev is not newer AND whose phase is
 * unchanged is stale and ignored. Returns the SAME map reference on a no-op so
 * callers can skip a re-render; otherwise a new Map with `key` updated. Pure —
 * unit-tested in useClaudeSessionState.test.ts.
 */
export function mergeSessionState(
  prev: Map<string, ClaudeSessionState>,
  key: string,
  incoming: ClaudeSessionState,
): Map<string, ClaudeSessionState> {
  const existing = prev.get(key);
  if (existing && incoming.rev <= existing.rev && existing.phase === incoming.phase) {
    return prev;
  }
  const next = new Map(prev);
  next.set(key, incoming);
  return next;
}

export function useClaudeSessionState(opts: UseClaudeSessionStateOptions): UseClaudeSessionStateResult {
  const [sessions, setSessions] = useState<Map<string, ClaudeSessionState>>(() => new Map());
  const [hydrated, setHydrated] = useState(false);
  // Ref mirror so the WS handler reads the freshest map without re-binding.
  const sessionsRef = useRefMirror(sessions);

  // session:state frames arrive per hook-phase transition — several per second
  // while a claude-code session runs through tools, × concurrent sessions. Each
  // one used to setState the map directly, re-rendering the App root (which
  // consumes this map → feeds the signals store) on EVERY frame. Coalesce a
  // burst into ONE commit per animation frame: buffer the freshest state per
  // key, then apply them together on the next rAF. The rev/phase guard still
  // runs at commit time (mergeSessionState), so ordering/staleness semantics
  // are unchanged; the only observable difference is a ≤1-frame (~16 ms) batch
  // delay. The completion notifier keeps its OWN session:state subscription, so
  // it still sees every frame — coalescing here never drops an edge it needs.
  const pendingRef = useRef<Map<string, ClaudeSessionState>>(new Map());
  const flushRafRef = useRef<number | null>(null);

  const flushSessions = useCallback(() => {
    flushRafRef.current = null;
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    pendingRef.current = new Map();
    setSessions((prev) => {
      let next = prev;
      for (const [key, incoming] of pending) next = mergeSessionState(next, key, incoming);
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushRafRef.current != null) return;
    flushRafRef.current = requestAnimationFrame(flushSessions);
  }, [flushSessions]);

  // Cancel any pending coalesced flush on unmount.
  useEffect(() => () => {
    if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
  }, []);

  const fetchUrl = opts.fetchUrl ?? '/api/claude-sessions';

  // Fetch the authoritative snapshot and REPLACE the local map. Returns a
  // cancel fn so an in-flight fetch can be abandoned on unmount / re-fetch.
  const bootstrap = useCallback((): (() => void) => {
    let cancelled = false;
    fetch(fetchUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { sessions?: ClaudeSessionState[] }) => {
        if (cancelled) return;
        const next = new Map<string, ClaudeSessionState>();
        for (const s of body.sessions ?? []) {
          // Topic sessions key off sessionKey; topic-less terminal sessions
          // off claudeSessionId. getByClaudeSessionId works for both.
          const key = s.sessionKey ?? s.claudeSessionId;
          if (key) next.set(key, s);
        }
        setSessions(next);
        setHydrated(true);
      })
      .catch((err) => {
        // Don't treat as fatal — the WS stream will populate over time.
        // Mark hydrated so consumers don't block on a missing endpoint.
        if (!cancelled) {
          console.warn('[useClaudeSessionState] bootstrap fetch failed', err);
          setHydrated(true);
        }
      });
    return () => { cancelled = true; };
  }, [fetchUrl]);

  // Bootstrap from server snapshot on mount.
  useEffect(() => bootstrap(), [bootstrap]);

  // Re-bootstrap on WS RECONNECT. `session:state` is transition-only, so a
  // phase that changed while the socket was down (or a session that ended)
  // never reaches us — leaving stale attention badges that the
  // stream alone can't heal. Re-fetching the authoritative snapshot on every
  // reconnect resets the map to server truth. The first 'open' coincides with
  // the mount fetch above, so we skip it to avoid a duplicate request.
  useEffect(() => {
    let seenFirstOpen = false;
    let cancelInFlight: (() => void) | undefined;
    const unsub = subscribeLifecycle((event) => {
      if (event !== 'open') return;
      if (!seenFirstOpen) { seenFirstOpen = true; return; }
      cancelInFlight?.();
      cancelInFlight = bootstrap();
    });
    return () => { unsub(); cancelInFlight?.(); };
  }, [bootstrap]);

  // Live updates — `useWSSubscription` owns the subscribe/cleanup shape; we
  // only define the per-message body. Frames are buffered per key and committed
  // once per animation frame (see flushSessions above).
  useWSSubscription(opts.onWSMessage, 'session:state', (msg) => {
    const incoming = msg.state;
    // Topic sessions key off sessionKey; topic-less terminal sessions off
    // claudeSessionId (sessionKey is null for those).
    const key = msg.sessionKey ?? incoming?.claudeSessionId;
    if (!incoming || !key) return;
    // Reject out-of-order revs against the freshest state we've seen this frame
    // (buffered) or already committed (mirror). A buffered entry always passed
    // this same guard vs. the committed map, so it dominates when present.
    const ref = pendingRef.current.get(key) ?? sessionsRef.current.get(key);
    if (ref && incoming.rev <= ref.rev && ref.phase === incoming.phase) return;
    pendingRef.current.set(key, incoming);
    scheduleFlush();
  });

  // Stale-attention TTL sweep. A session that DIES without a terminating event
  // (process killed, SessionEnd hook lost, and no WS reconnect to heal via the
  // bootstrap above) keeps its phase forever — an amber/blue tab "lit up at
  // random" long after anything is really waiting on you. So periodically demote
  // an ABANDONED attention phase to `dormant` (no fill). Deliberately scoped to
  // `awaiting-approval` + `paused`: a stale permission gate is the worst offender
  // (the server reaper turns awaiting-approval→paused at 10 min, then it sits
  // forever). `awaiting-user` is LEFT ALONE — "your turn" legitimately lasts as
  // long as you're away, and the focus-clears-the-fill rule already stops it
  // flashing on the tab you're viewing. Server truth still wins: a fresh
  // session:state (or the reconnect bootstrap) re-instates a real phase.
  useEffect(() => {
    const STALE_MS = 30 * 60_000; // 30 min with no update → treat as abandoned
    const sweep = () => {
      const now = Date.now();
      setSessions((prev) => {
        let changed = false;
        let next: Map<string, ClaudeSessionState> | null = null;
        for (const [key, st] of prev) {
          if (st.phase !== 'awaiting-approval' && st.phase !== 'paused') continue;
          const last = st.updatedAt || st.phaseUpdatedAt || 0;
          if (now - last < STALE_MS) continue;
          if (!next) next = new Map(prev);
          next.set(key, { ...st, phase: 'dormant', phaseUpdatedAt: now, updatedAt: now });
          changed = true;
        }
        return changed && next ? next : prev;
      });
    };
    const interval = setInterval(sweep, 5 * 60_000); // check every 5 min
    return () => clearInterval(interval);
  }, []);

  const getByClaudeSessionId = useCallback((id: string): ClaudeSessionState | undefined => {
    for (const s of sessionsRef.current.values()) {
      if (s.claudeSessionId === id) return s;
    }
    return undefined;
  }, [sessionsRef]);

  return useMemo(() => ({ sessions, getByClaudeSessionId, hydrated }), [sessions, getByClaudeSessionId, hydrated]);
}
