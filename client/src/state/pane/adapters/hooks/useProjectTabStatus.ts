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

interface ScriptEntry {
  status: string;
  projectPath?: string;
}

function readRunningScriptCounts(): Record<string, number> {
  // Legacy hook pulled from useScripts() — we read the same in-memory event
  // log via a custom window bridge that useScripts dispatches on update.
  // During Phase 30's cutover the adapter doesn't depend on useScripts directly
  // (to keep the legacy file truly deletable); consumers that want a live count
  // can dispatch a 'scripts-updated' CustomEvent with a detail payload, or the
  // adapter will simply return 0s (sidebar still renders correctly).
  const counts: Record<string, number> = {};
  try {
    const cached = (window as unknown as {
      __gsdScriptsSnapshot?: ScriptEntry[];
    }).__gsdScriptsSnapshot;
    if (Array.isArray(cached)) {
      for (const s of cached) {
        if (s?.status === 'running' && s.projectPath) {
          counts[s.projectPath] = (counts[s.projectPath] || 0) + 1;
        }
      }
    }
  } catch {
    /* no snapshot — return empty counts */
  }
  return counts;
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
      const scriptCounts = readRunningScriptCounts();
      for (const path of projectPaths) {
        const git = readGitCache(path);
        const runningProcessCount = scriptCounts[path] ?? 0;
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
    const scriptsHandler = () => refresh();
    window.addEventListener('git-cache-updated', gitHandler);
    window.addEventListener('scripts-updated', scriptsHandler);
    return () => {
      window.removeEventListener('git-cache-updated', gitHandler);
      window.removeEventListener('scripts-updated', scriptsHandler);
    };
  }, [refresh, projectPaths.length]);

  return status;
}
