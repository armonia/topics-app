/**
 * useTerminalLifecycle — owns terminal session state + grace-period ref +
 * terminal:sessions WS subscription + a pure prune helper.
 *
 * Extracted from App.tsx during Phase 3 (hook 2 of 4). Per CRITIQUE C5:
 * NO `setOpenPanels` argument. Cleanup lives in `usePanelLifecycle` and
 * uses `pruneStaleTerminalPanes` — a pure function that returns the panes
 * to KEEP (preserving array reference equality on no-op, required by
 * CRITIQUE C4 to avoid spuriously triggering the validation effect).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSessionInfo, WSMessage } from '../types';
import type { TerminalOps } from './appHookTypes';
import { useRefMirror } from './useRefMirror';

export interface UseTerminalLifecycleArgs {
  wsStatus: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export interface UseTerminalLifecycleReturn {
  sessions: TerminalSessionInfo[];
  refs: {
    /** Read-only ref. Lets pruneStaleTerminalPanes know whether the
     *  initial fetch completed (so it doesn't drop optimistic terminals
     *  before the first /api/terminal/sessions response). */
    terminalSessionsLoadedRef: React.MutableRefObject<boolean>;
    /** Map of recently-created terminal session ids → timestamp. The
     *  panel hook writes via `ops.markRecentlyCreated`; the prune helper
     *  reads + expires entries during cleanup. */
    recentlyCreatedTerminalsRef: React.MutableRefObject<Map<string, number>>;
  };
  ops: TerminalOps;
  /**
   * Pure helper. Given the current pane id list, returns the list to
   * KEEP (filtered for stale terminal panes, with a 5s grace exception
   * for sessions just created by `markRecentlyCreated`).
   *
   * INVARIANT (CRITIQUE C4): returns the input array unchanged on no-op
   * — callers rely on `filtered === input` reference equality so
   * downstream effects don't loop.
   */
  pruneStaleTerminalPanes: (currentPaneIds: string[]) => string[];
}

const GRACE_MS = 5000;

export function useTerminalLifecycle(args: UseTerminalLifecycleArgs): UseTerminalLifecycleReturn {
  const { wsStatus, onWSMessage } = args;

  const [sessions, setSessions] = useState<TerminalSessionInfo[]>(() => {
    try {
      const cached = localStorage.getItem('terminal-sessions-cache');
      if (cached) { const p = JSON.parse(cached); if (Array.isArray(p)) return p; }
    } catch {}
    return [];
  });

  const terminalSessionsLoadedRef = useRef(false);
  // ISSUE 13 fix: track recently created terminal session IDs with timestamps
  // to avoid cleanup race when server WS broadcast hasn't caught up yet.
  const recentlyCreatedTerminalsRef = useRef<Map<string, number>>(new Map());

  // Internal mirror so the pure helper can be a stable callback (no deps,
  // never re-created — keeps the panel hook's terminal-cleanup effect
  // from re-firing every render). useRefMirror is the canonical helper
  // for this state→ref bridge.
  const sessionsRef = useRefMirror(sessions);

  // Merge an authoritative list with any OPTIMISTIC entries still inside
  // their creation grace: a roster fetched (or broadcast) before the server
  // registered a just-created terminal would otherwise wholesale-replace the
  // optimistic entry away — the pane survives via recentlyCreatedTerminalsRef,
  // but its name/cwd metadata (read from `sessions`) blanked until the next
  // real broadcast. Entries past the grace defer to server truth.
  const mergeWithOptimistic = useCallback((incoming: TerminalSessionInfo[]): TerminalSessionInfo[] => {
    const now = Date.now();
    const ids = new Set(incoming.map(s => s.id));
    const keep = sessionsRef.current.filter(s => {
      if (ids.has(s.id)) return false;
      const ts = recentlyCreatedTerminalsRef.current.get(s.id);
      return ts !== undefined && now - ts <= GRACE_MS;
    });
    return keep.length ? [...incoming, ...keep] : incoming;
  }, [sessionsRef]);

  const fetchTerminalSessions = useCallback(() => {
    fetch('/api/terminal/sessions').then(r => r.json()).then((data: TerminalSessionInfo[]) => {
      terminalSessionsLoadedRef.current = true;
      const merged = mergeWithOptimistic(data);
      setSessions(merged);
      try { localStorage.setItem('terminal-sessions-cache', JSON.stringify(merged)); } catch {}
    }).catch(() => {});
  }, [mergeWithOptimistic]);

  // Fetch on mount
  useEffect(() => { fetchTerminalSessions(); }, [fetchTerminalSessions]);

  // Re-fetch on WS reconnect
  useEffect(() => {
    if (wsStatus === 'connected') {
      fetchTerminalSessions();
    }
  }, [wsStatus, fetchTerminalSessions]);

  // WS terminal:sessions subscription — same optimistic-grace merge as the
  // fetch path (an unrelated broadcast can land before a new terminal's
  // registration reaches the roster).
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'terminal:sessions') {
        const merged = mergeWithOptimistic(msg.sessions);
        setSessions(merged);
        try { localStorage.setItem('terminal-sessions-cache', JSON.stringify(merged)); } catch {}
      }
    });
  }, [onWSMessage, mergeWithOptimistic]);

  // Ops exposed to the panel hook (written via handleQuickCreateTerminal /
  // handleCloseTerminal — which live in usePanelLifecycle).
  const addOptimisticSession = useCallback((session: TerminalSessionInfo) => {
    setSessions(prev => prev.some(s => s.id === session.id) ? prev : [...prev, session]);
  }, []);

  const markRecentlyCreated = useCallback((sessionId: string) => {
    recentlyCreatedTerminalsRef.current.set(sessionId, Date.now());
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId));
  }, []);

  const pruneStaleTerminalPanes = useCallback((currentPaneIds: string[]): string[] => {
    if (!terminalSessionsLoadedRef.current) return currentPaneIds;
    const sessionIds = new Set(sessionsRef.current.map(s => s.id));
    const now = Date.now();
    // Prune expired entries from recentlyCreated
    for (const [id, ts] of recentlyCreatedTerminalsRef.current) {
      if (now - ts > GRACE_MS) recentlyCreatedTerminalsRef.current.delete(id);
    }
    const filtered = currentPaneIds.filter(id => {
      if (!id.startsWith('terminal:')) return true;
      const sessionId = id.slice('terminal:'.length);
      return sessionIds.has(sessionId) || recentlyCreatedTerminalsRef.current.has(sessionId);
    });
    return filtered.length === currentPaneIds.length ? currentPaneIds : filtered;
    // sessionsRef is a stable ref object (identity never changes), so listing
    // it keeps the callback's identity stable — this stays a zero-churn
    // callback as the cleanup effect requires while satisfying exhaustive-deps.
  }, [sessionsRef]);

  return {
    sessions,
    refs: { terminalSessionsLoadedRef, recentlyCreatedTerminalsRef },
    ops: { addOptimisticSession, markRecentlyCreated, removeSession },
    pruneStaleTerminalPanes,
  };
}
