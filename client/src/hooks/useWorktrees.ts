/**
 * useWorktrees — Phase A · client cache for the Worktree entity.
 *
 * Two operating modes:
 *   1. Project-scoped (`{ projectId: '…' }`): list worktrees belonging
 *      to one project. Best for the Worktree picker inside the New
 *      Topic dialog or the topic settings modal.
 *   2. Global (`{}`): list every worktree across all projects.
 *
 * Subscribes to `worktree:*` WebSocket envelopes and folds them in:
 *   · `worktree:new`     → prepend to list (status starts as pending)
 *   · `worktree:updated` → patch the row in place (status flips
 *                          pending → ready / error; rename in place)
 *   · `worktree:deleted` → remove by id
 *
 * State machine awareness: when a row's `status === 'pending'` the UI
 * should show a loader. The `status === 'error'` row keeps its
 * `errorMessage` so the user can read the git stderr without a
 * separate API call.
 *
 * Mirrors the pattern of `useProjects` and `useGitStatus`: the caller
 * passes `onMessage` from `useWebSocket()` so subscription is opt-in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Worktree, WSMessage } from '../types';
import { worktreesApi } from '../lib/api';

interface UseWorktreesOptions {
  /** Restrict the list to one project. Omit to load all worktrees. */
  projectId?: string;
  /** Pass `useWebSocket().onMessage` to receive live updates. */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

interface UseWorktreesResult {
  worktrees: Worktree[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  byId: (id: string) => Worktree | undefined;
  /** Convenience: only ready (materialised) rows. */
  ready: Worktree[];
}

export function useWorktrees(options: UseWorktreesOptions = {}): UseWorktreesResult {
  const { projectId, onMessage } = options;
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const result = await worktreesApi.list(projectId ? { projectId } : undefined);
      if (mountedRef.current) setWorktrees(result.worktrees);
    } catch (err: unknown) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to load worktrees');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [projectId]);

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
      if (msg.type === 'worktree:new' || msg.type === 'worktree:updated') {
        // Full row on new/updated (the union types it as Partial for the
        // shared deleted shape; at runtime new/updated carry the whole row).
        const wt = msg.worktree as Worktree | undefined;
        if (!wt) return;
        // When project-scoped, ignore broadcasts for other projects.
        if (projectId && wt.projectId !== projectId) return;
        setWorktrees((prev) => {
          const idx = prev.findIndex((w) => w.id === wt.id);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = wt;
            return next;
          }
          return [wt, ...prev];
        });
      } else if (msg.type === 'worktree:deleted') {
        // The server emits `worktree:deleted` with a top-level `{ id }`
        // (server/routes/worktrees.ts), while the WS type declares the id
        // nested under `worktree`. Accept both shapes at runtime.
        const topLevelId = (msg as { id?: string }).id;
        const id = msg.worktree?.id ?? topLevelId;
        if (!id) return;
        setWorktrees((prev) => prev.filter((w) => w.id !== id));
      }
    });
    return unsub;
  }, [onMessage, projectId]);

  const byId = useCallback(
    (id: string) => worktrees.find((w) => w.id === id),
    [worktrees],
  );
  const ready = worktrees.filter((w) => w.status === 'ready');

  return { worktrees, loading, error, refresh, byId, ready };
}
