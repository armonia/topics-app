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

import { useCallback, useEffect, useMemo, useState } from 'react';
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

export function useClaudeSessionState(opts: UseClaudeSessionStateOptions): UseClaudeSessionStateResult {
  const [sessions, setSessions] = useState<Map<string, ClaudeSessionState>>(() => new Map());
  const [hydrated, setHydrated] = useState(false);
  // Ref mirror so the WS handler reads the freshest map without re-binding.
  const sessionsRef = useRefMirror(sessions);

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

  // Live updates — `useWSSubscription` owns the subscribe/cleanup
  // shape; we only define the per-message body.
  useWSSubscription(opts.onWSMessage, 'session:state', (msg) => {
    const incoming = msg.state;
    // Topic sessions key off sessionKey; topic-less terminal sessions off
    // claudeSessionId (sessionKey is null for those).
    const key = msg.sessionKey ?? incoming?.claudeSessionId;
    if (!incoming || !key) return;
    const cur = sessionsRef.current.get(key);
    // Reject out-of-order revs.
    if (cur && incoming.rev <= cur.rev && cur.phase === incoming.phase) return;
    setSessions((prev) => {
      const existing = prev.get(key);
      if (existing && incoming.rev <= existing.rev && existing.phase === incoming.phase) {
        return prev;
      }
      const next = new Map(prev);
      next.set(key, incoming);
      return next;
    });
  });

  const getByClaudeSessionId = useCallback((id: string): ClaudeSessionState | undefined => {
    for (const s of sessionsRef.current.values()) {
      if (s.claudeSessionId === id) return s;
    }
    return undefined;
  }, []);

  return useMemo(() => ({ sessions, getByClaudeSessionId, hydrated }), [sessions, getByClaudeSessionId, hydrated]);
}
