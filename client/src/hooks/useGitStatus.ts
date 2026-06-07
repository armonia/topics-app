import { useState, useEffect, useCallback, useRef } from 'react';
import { gitApi } from '../lib/api';
import type { GitStatus, WSMessage } from '../types';

const POLL_VISIBLE = 15000;
const POLL_BACKGROUND = 60000;
const CACHE_KEY = 'git-status-cache';

type GitCacheEntry = { status: GitStatus; remotes: { name: string; fetchUrl: string; pushUrl: string }[] };

// ── Session cache (shared with other consumers via sessionStorage) ──────────

const gitCache = {
  get(path: string): GitCacheEntry | undefined {
    try {
      const raw = sessionStorage.getItem(`${CACHE_KEY}:${path}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  },
  set(path: string, entry: GitCacheEntry) {
    try {
      sessionStorage.setItem(`${CACHE_KEY}:${path}`, JSON.stringify(entry));
    } catch { /* quota exceeded — ignore */ }
  },
};

// ── Shared per-projectPath fetching ─────────────────────────────────────────
// Multiple components for the same project share one poll timer.

// activePollers removed — was unused

interface UseGitStatusOptions {
  projectPath: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export { gitCache };

export function useGitStatus({ projectPath, onMessage }: UseGitStatusOptions) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(() => {
    const cached = gitCache.get(projectPath);
    return cached?.status ?? null;
  });
  const [loading, setLoading] = useState(!gitCache.get(projectPath));
  const [error, setError] = useState<string | null>(null);
  const [notGit, setNotGit] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsConnectedRef = useRef(false);

  const notGitRef = useRef(false);

  const loadStatus = useCallback(async () => {
    // Don't re-fetch if we already know this isn't a git repo
    if (notGitRef.current) return;
    try {
      setLoading(true);
      setError(null);
      const status = await gitApi.status(projectPath);
      // Server returns { notGit: true } for non-git directories (200 OK, no error)
      if ((status as { notGit?: boolean }).notGit) {
        notGitRef.current = true;
        setNotGit(true);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        return;
      }
      setNotGit(false);
      setGitStatus(status);
      // Update cache
      const prev = gitCache.get(projectPath);
      gitCache.set(projectPath, { status, remotes: prev?.remotes ?? [] });
      window.dispatchEvent(new CustomEvent('git-cache-updated'));
    } catch (err: unknown) {
      const e = err as { notGit?: boolean; message?: string } | null | undefined;
      if (e?.notGit) {
        notGitRef.current = true;
        setNotGit(true);
        setError(null); // Not a real error — just not a git repo
      } else {
        setError(e?.message || 'Git error');
      }
      // Stop polling on persistent errors (notGit, missing dir, etc.)
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // Set up polling with appropriate interval
  const setupPolling = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    const interval = wsConnectedRef.current ? POLL_BACKGROUND : POLL_VISIBLE;
    timerRef.current = setInterval(loadStatus, interval);
  }, [loadStatus]);

  // Initial fetch + polling
  useEffect(() => {
    loadStatus();
    setupPolling();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadStatus, setupPolling]);

  // Listen to WS for git:status pushes
  useEffect(() => {
    if (!onMessage) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (msg.type === 'git:status' && msg.projectPath === projectPath && msg.status) {
        const status = msg.status as GitStatus;
        setGitStatus(status);
        setNotGit(false);
        setError(null);
        // Update cache
        const prev = gitCache.get(projectPath);
        gitCache.set(projectPath, { status, remotes: prev?.remotes ?? [] });
        window.dispatchEvent(new CustomEvent('git-cache-updated'));
      }
    });
    wsConnectedRef.current = true;
    setupPolling();
    return () => {
      unsub();
      wsConnectedRef.current = false;
      setupPolling();
    };
  }, [onMessage, projectPath, setupPolling]);

  return {
    gitStatus,
    loading,
    error,
    notGit,
    reload: loadStatus,
    gitCache,
  };
}
