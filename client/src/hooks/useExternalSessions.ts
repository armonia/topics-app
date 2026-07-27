/**
 * useExternalSessions — the Claude sessions running OUTSIDE Topics.
 *
 * The board judges a project by its cards, so a repo with three bare `claude`
 * sessions and zero tasks reads as "fermo" when it's the busiest one. This hook
 * feeds the header badge that says otherwise.
 *
 * One fetch on mount, then the server pushes `external-sessions` whenever the
 * census CHANGES (see services/external-sessions.ts) — no client polling.
 * Filter by `projectId` for a single board; omit it for the global view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WSMessage } from '../types';

export interface ExternalSession {
  sessionId: string;
  cwd: string;
  projectPath: string | null;
  projectId: string | null;
  branch: string | null;
  entrypoint: string | null;
  lastActivityMs: number;
  state: 'active' | 'idle';
}

export function useExternalSessions(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
  projectId?: string,
): ExternalSession[] {
  const [sessions, setSessions] = useState<ExternalSession[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/external-sessions');
      if (!res.ok) return;
      const body = await res.json() as { sessions?: ExternalSession[] };
      setSessions(Array.isArray(body.sessions) ? body.sessions : []);
    } catch {
      /* keep the last known census on a transient failure */
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; sessions?: ExternalSession[] };
      if (m?.type !== 'external-sessions') return;
      setSessions(Array.isArray(m.sessions) ? m.sessions : []);
    });
  }, [onMessage]);

  return useMemo(
    () => (projectId ? sessions.filter((s) => s.projectId === projectId) : sessions),
    [sessions, projectId],
  );
}
