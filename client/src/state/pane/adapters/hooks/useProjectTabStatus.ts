/**
 * Hook for per-project tab status indicators (git file count, ahead/behind,
 * branch name, running process count). Data comes from a sessionStorage git
 * cache plus the running-scripts data stream — no pane-store involvement.
 * When a future phase introduces pane-state-backed status fields, fold them
 * in through `usePaneStore`.
 */
import { useState, useEffect, useCallback } from 'react';

const CACHE_KEY = 'git-status-cache';

export interface ProjectTabStatus {
  gitFileCount: number;
  gitAhead: number;
  gitBehind: number;
  gitBranch: string;
  runningProcessCount: number;
}

function readGitCache(path: string): {
  fileCount: number;
  ahead: number;
  behind: number;
  branch: string;
} {
  try {
    const raw = sessionStorage.getItem(`${CACHE_KEY}:${path}`);
    if (!raw) return { fileCount: 0, ahead: 0, behind: 0, branch: '' };
    const entry = JSON.parse(raw);
    const status = entry.status;
    if (!status) return { fileCount: 0, ahead: 0, behind: 0, branch: '' };
    return {
      fileCount: status.files?.length ?? 0,
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0,
      branch: status.branch ?? '',
    };
  } catch {
    return { fileCount: 0, ahead: 0, behind: 0, branch: '' };
  }
}

export function useProjectTabStatus(
  projectPaths: string[],
): Record<string, ProjectTabStatus> {
  const [status, setStatus] = useState<Record<string, ProjectTabStatus>>({});
  const pathsKey = projectPaths.join('\n');

  const refresh = useCallback(() => {
    setStatus((prev) => {
      let changed = false;
      const next: Record<string, ProjectTabStatus> = { ...prev };
      for (const path of projectPaths) {
        const git = readGitCache(path);
        // Running-process counts came from a `useScripts` window bridge that was
        // never wired up (no writer for `__gsdScriptsSnapshot` / `scripts-updated`).
        // Always 0 until a pane-state-backed source lands.
        const runningProcessCount = 0;
        const old = prev[path];
        if (
          !old ||
          old.gitFileCount !== git.fileCount ||
          old.gitAhead !== git.ahead ||
          old.gitBehind !== git.behind ||
          old.gitBranch !== git.branch ||
          old.runningProcessCount !== runningProcessCount
        ) {
          changed = true;
          next[path] = {
            gitFileCount: git.fileCount,
            gitAhead: git.ahead,
            gitBehind: git.behind,
            gitBranch: git.branch,
            runningProcessCount,
          };
        }
      }
      return changed ? next : prev;
    });
    // pathsKey listed as dep so callers see refresh restart on path list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: pathsKey is the stable content-hash of projectPaths; depending on the array itself would re-create `refresh` on every render (callers pass a fresh array each time), while pathsKey changes exactly when the path list content changes
  }, [pathsKey]);

  useEffect(() => {
    if (projectPaths.length === 0) return;
    refresh();
    const gitHandler = () => refresh();
    window.addEventListener('git-cache-updated', gitHandler);
    return () => {
      window.removeEventListener('git-cache-updated', gitHandler);
    };
  }, [refresh, projectPaths.length]);

  return status;
}
