/**
 * External Claude sessions — the read-only overlay of Claude Code sessions
 * running OUTSIDE Topics (a bare `claude` in a terminal on any repo), detected
 * server-side by the mtime sweep of ~/.claude/projects.
 *
 * One tiny zustand store fed by a single sync hook (mounted once in App):
 * bootstrap from GET /api/external-sessions, then live `external-sessions:state`
 * WS frames replace the whole list (the server always broadcasts the full
 * snapshot, so there is no merge logic to get wrong). Consumers (the sidebar
 * project rows) read per-project slices via `countExternalForProject`.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { useWSSubscription } from '../hooks/useWSSubscription';
import type { ExternalClaudeSession, WSMessage } from '../types';

interface ExternalSessionsStore {
  sessions: ExternalClaudeSession[];
  setSessions: (sessions: ExternalClaudeSession[]) => void;
}

export const useExternalSessionsStore = create<ExternalSessionsStore>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
}));

/** Same lossy encoding Claude Code uses for its per-cwd transcript dirs —
 *  the fallback match when a session's real cwd could not be read. */
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function isPathWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

/** External sessions attributable to a project path (cwd nested either way,
 *  or encoded-dirName match when the cwd is unknown). */
export function externalSessionsForProject(
  sessions: ExternalClaudeSession[],
  projectPath: string,
): ExternalClaudeSession[] {
  const encoded = encodeClaudeCwd(projectPath);
  return sessions.filter((s) =>
    s.cwd
      ? isPathWithin(s.cwd, projectPath) || isPathWithin(projectPath, s.cwd)
      : s.dirName === encoded,
  );
}

/** Mount ONCE (App): bootstrap + live WS sync into the store. */
export function useExternalSessionsSync(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): void {
  const setSessions = useExternalSessionsStore((s) => s.setSessions);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/external-sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { sessions?: ExternalClaudeSession[] }) => {
        if (!cancelled) setSessions(body.sessions ?? []);
      })
      .catch(() => { /* WS frames will populate over time */ });
    return () => { cancelled = true; };
  }, [setSessions]);

  useWSSubscription(onWSMessage, 'external-sessions:state', (msg) => {
    setSessions(msg.sessions ?? []);
  });
}
