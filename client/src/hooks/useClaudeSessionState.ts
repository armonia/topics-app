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

  // Bootstrap from server snapshot.
  useEffect(() => {
    let cancelled = false;
    const url = opts.fetchUrl ?? '/api/claude-sessions';
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { sessions?: ClaudeSessionState[] }) => {
        if (cancelled) return;
        const next = new Map<string, ClaudeSessionState>();
        for (const s of body.sessions ?? []) {
          if (s.sessionKey) next.set(s.sessionKey, s);
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
  }, [opts.fetchUrl]);

  // Live updates — `useWSSubscription` owns the subscribe/cleanup
  // shape; we only define the per-message body.
  useWSSubscription(opts.onWSMessage, 'session:state', (msg) => {
    const incoming = msg.state;
    if (!incoming || !msg.sessionKey) return;
    const cur = sessionsRef.current.get(msg.sessionKey);
    // Reject out-of-order revs.
    if (cur && incoming.rev <= cur.rev && cur.phase === incoming.phase) return;
    setSessions((prev) => {
      const existing = prev.get(msg.sessionKey);
      if (existing && incoming.rev <= existing.rev && existing.phase === incoming.phase) {
        return prev;
      }
      const next = new Map(prev);
      next.set(msg.sessionKey, incoming);
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
