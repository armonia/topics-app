import { useState, useEffect, useCallback } from 'react';
import { useScripts } from './useScripts';

const CACHE_KEY = 'git-status-cache';

export interface ProjectTabStatus {
  gitFileCount: number;
  gitAhead: number;
  gitBehind: number;
  gitBranch: string;
  runningProcessCount: number;
}

function readGitCache(path: string): { fileCount: number; ahead: number; behind: number; branch: string } {
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

export function useProjectTabStatus(projectPaths: string[]): Record<string, ProjectTabStatus> {
  const [status, setStatus] = useState<Record<string, ProjectTabStatus>>({});
  const pathsKey = projectPaths.join('\n');

  // Use shared scripts hook — no duplicate polling
  const { allScripts } = useScripts();

  // Read git cache for all paths
  const refreshGit = useCallback(() => {
    setStatus(prev => {
      let changed = false;
      const next = { ...prev };
      for (const path of projectPaths) {
        const git = readGitCache(path);
        const old = prev[path];
        if (!old || old.gitFileCount !== git.fileCount || old.gitAhead !== git.ahead || old.gitBehind !== git.behind || old.gitBranch !== git.branch) {
          changed = true;
          next[path] = {
            gitFileCount: git.fileCount,
            gitAhead: git.ahead,
            gitBehind: git.behind,
            gitBranch: git.branch,
            runningProcessCount: old?.runningProcessCount ?? 0,
          };
        }
      }
      return changed ? next : prev;
    });
  }, [pathsKey]);

  // Derive running process counts from shared scripts data
  useEffect(() => {
    const counts: Record<string, number> = {};
    for (const s of allScripts) {
      if (s.status === 'running' && s.projectPath) {
        counts[s.projectPath] = (counts[s.projectPath] || 0) + 1;
      }
    }
    setStatus(prev => {
      let changed = false;
      const next = { ...prev };
      for (const path of projectPaths) {
        const count = counts[path] ?? 0;
        const old = prev[path];
        if (!old || old.runningProcessCount !== count) {
          changed = true;
          next[path] = {
            gitFileCount: old?.gitFileCount ?? 0,
            gitAhead: old?.gitAhead ?? 0,
            gitBehind: old?.gitBehind ?? 0,
            gitBranch: old?.gitBranch ?? '',
            runningProcessCount: count,
          };
        }
      }
      return changed ? next : prev;
    });
  }, [allScripts, pathsKey]);

  // Initial read + listen for git-cache-updated events
  useEffect(() => {
    if (projectPaths.length === 0) return;
    refreshGit();
    const handler = () => refreshGit();
    window.addEventListener('git-cache-updated', handler);
    return () => window.removeEventListener('git-cache-updated', handler);
  }, [refreshGit, projectPaths.length]);

  return status;
}
