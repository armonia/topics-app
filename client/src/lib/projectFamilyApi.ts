/**
 * Accorpa / separa from the client: the project rows (with `parentId` and
 * `mergeMode`) and the PATCH that changes them. Kept apart from `apiSystem.ts`,
 * whose `projectsApi.update` types only the cosmetic fields.
 */
import { apiFetch } from './shell/net';
import type { Project } from '../types';
import type { FamilyRow, MergeMode } from '../../../shared/project-family';

export async function listProjectRows(): Promise<Project[]> {
  const res = await apiFetch('/api/projects', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { projects?: Project[] };
  return body.projects ?? [];
}

/** Sets the parent (`null` detaches) and/or the mode of one project. Cards never move. */
export async function setProjectFamily(id: string, change: { parentId?: string | null; mergeMode?: MergeMode }): Promise<Project> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  });
  const body = (await res.json().catch(() => null)) as (Project & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** A project row as the pure family logic reads it. */
export function toFamilyRow(p: Project): FamilyRow {
  return { id: p.id, path: p.path, name: p.name, archived: p.archived, parentId: p.parentId ?? null, mergeMode: p.mergeMode ?? 'accorpa' };
}

/** What to call a project in a list: its name, or the last folder of its path. */
export function projectDisplayName(r: { name?: string | null; path: string }): string {
  return r.name || r.path.split('/').pop() || r.path;
}
