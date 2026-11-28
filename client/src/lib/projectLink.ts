/**
 * `/?project=<quota project id>`: the link the pause alert carries. The id is a
 * hash of the folder, so the path comes from the quota reading (which lists
 * every project with its folder) and the project then opens like any other
 * `project` tab link.
 */
import type { ProjectQuotaResponse } from '../../../shared/usage-shapes';
import { apiFetch } from './shell/net';
import { openTabInAppWhenHydrated } from './tabLink';

/** The id in a query string, or null. */
export function projectIdFromSearch(search: string): string | null {
  try {
    const id = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('project');
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/** The same URL without `project`, the way the other deep links are consumed (a reload must not reopen it). */
export function stripProjectParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('project');
  return url.pathname + (url.search || '') + url.hash;
}

/** Finds the folder of a project id in a quota reading. */
export function projectPathForId(quota: Pick<ProjectQuotaResponse, 'projects'>, id: string): string | null {
  return quota.projects.find((p) => p.projectId === id)?.projectPath ?? null;
}

/** Consumes the param, resolves the folder and opens the project. Returns whether a link was present. */
export function consumeProjectLink(notify?: (message: string) => void): boolean {
  const id = projectIdFromSearch(window.location.search);
  if (!id) return false;
  try { window.history.replaceState(window.history.state, '', stripProjectParam(window.location.href)); } catch { /* the link still opens */ }
  void (async () => {
    try {
      const res = await apiFetch('/api/usage/projects/quota');
      if (!res.ok) return;
      const path = projectPathForId((await res.json()) as ProjectQuotaResponse, id);
      if (path) openTabInAppWhenHydrated({ kind: 'project', key: path }, notify ? { notify } : undefined);
    } catch { /* an old link opens nothing; the app is already on screen */ }
  })();
  return true;
}
