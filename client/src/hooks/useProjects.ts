/**
 * useProjects — Phase A · client cache for the Project entity.
 *
 * Loads `/api/projects` on mount, then subscribes to `project:*`
 * WebSocket envelopes (new/updated/archived/deleted) and keeps an
 * in-memory list in sync. Mirrors the pattern of `useGitStatus`: the
 * caller passes the `onMessage` registrar from `useWebSocket()` so
 * subscription is opt-in and unit-testable.
 *
 * Phase A scope: archived projects are excluded by default. The
 * deliberate decision is to keep this hook minimal — list + subscribe.
 * Mutation calls go straight to `projectsApi.*` from the consumer; the
 * `project:*` broadcast that follows the server commit will fold the
 * fresh row into this list automatically. There is no optimistic
 * mutation here on purpose: we don't ship an entity that *only* the
 * client knows about.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, WSMessage } from '../types';
import { projectsApi } from '../lib/api';

interface UseProjectsOptions {
  /** Pass `useWebSocket().onMessage` to receive live updates. */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** When true, includes archived projects. Defaults to false. */
  includeArchived?: boolean;
}

interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Convenience accessor for the project at a given filesystem path. */
  byPath: (path: string) => Project | undefined;
  byId: (id: string) => Project | undefined;
}

export function useProjects(options: UseProjectsOptions = {}): UseProjectsResult {
  const { onMessage, includeArchived = false } = options;
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Used to debounce duplicate broadcasts during a single tick.
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const result = await projectsApi.list(
        includeArchived ? {} : { archived: false },
      );
      if (mountedRef.current) setProjects(result.projects);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message ?? 'Failed to load projects');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    const unsub = onMessage((msg: WSMessage) => {
      // The router emits these envelopes via broadcastToAll; see
      // server/routes/projects.ts. Each carries `payload_version: 1`.
      if (msg.type === 'project:new' || msg.type === 'project:updated') {
        const project = (msg as any).project as Project | undefined;
        if (!project) return;
        // Honour the includeArchived filter — push the row only if visible.
        if (!includeArchived && project.archived) {
          // It might already be in the list (was active, just got archived):
          setProjects((prev) => prev.filter((p) => p.id !== project.id));
          return;
        }
        setProjects((prev) => {
          const idx = prev.findIndex((p) => p.id === project.id);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = project;
            return next;
          }
          return [project, ...prev];
        });
      } else if (msg.type === 'project:archived') {
        const project = (msg as any).project as Project | undefined;
        if (!project) return;
        if (includeArchived) {
          // Just update the row in place.
          setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
        } else {
          setProjects((prev) => prev.filter((p) => p.id !== project.id));
        }
      } else if (msg.type === 'project:deleted') {
        const id = (msg as any).project?.id ?? (msg as any).id;
        if (!id) return;
        setProjects((prev) => prev.filter((p) => p.id !== id));
      }
    });
    return unsub;
  }, [onMessage, includeArchived]);

  const byPath = useCallback(
    (path: string) => projects.find((p) => p.path === path),
    [projects],
  );
  const byId = useCallback(
    (id: string) => projects.find((p) => p.id === id),
    [projects],
  );

  return { projects, loading, error, refresh, byPath, byId };
}
