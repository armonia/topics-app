/**
 * Plan calls (`/api/plan`) and response types. The types mirror
 * `server/services/plan.ts`: the client recomputes nothing, it only shows.
 */
import { apiFetch } from '../../lib/shell/net';

export type PlanSignal = 'duplicate' | 'delivered_but_open' | 'no_owner' | 'stale';
export type PlanSourceKind = 'session' | 'pr' | 'branch' | 'commit' | 'check' | 'cron' | 'other';

export interface PlanSource { id?: string; kind: PlanSourceKind; label: string; url?: string | null; topicId?: string | null; implicit: boolean }
export interface PlanProgress { total: number; done: number; byStatus: Record<string, number>; ratio: number }
export interface PlanCard {
  id: string; text: string; status: string; projectId: string;
  assignedTopicId: string | null; originTopicId: string | null; updatedAt: string;
  signals: PlanSignal[]; duplicateOf?: string; sources: PlanSource[];
}
export interface PlanMilestone {
  id: string; areaId: string; title: string; expectedResult: string | null; completionCriteria: string | null;
  owner: string | null; status: string; dueDate: string | null; position: number;
  progress: PlanProgress; signals: PlanSignal[]; sources: PlanSource[]; tasks: PlanCard[];
}
export interface PlanArea { id: string; projectId: string; name: string; position: number; progress: PlanProgress; milestones: PlanMilestone[] }
export interface PlanProject {
  projectId: string; name: string; progress: PlanProgress; areas: PlanArea[];
  unplaced: { progress: PlanProgress; tasks: PlanCard[] };
}
export interface PlanTree { projects: PlanProject[]; includeDone: boolean }

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const fetchPlan = (includeDone: boolean) => send<PlanTree>('GET', `/plan${includeDone ? '?includeDone=1' : ''}`);
export const createArea = (projectId: string, name: string) => send('POST', '/plan/areas', { projectId, name });
export const createMilestone = (input: {
  areaId: string; title: string; expectedResult?: string; completionCriteria?: string; owner?: string; dueDate?: string;
}) => send('POST', '/plan/milestones', input);
export const updateMilestone = (id: string, patch: { owner?: string; dueDate?: string }) => send('PATCH', `/plan/milestones/${encodeURIComponent(id)}`, patch);
export const linkCard = (taskId: string, milestoneId: string) => send('PUT', `/plan/links/${encodeURIComponent(taskId)}`, { milestoneId });
export const unlinkCard = (taskId: string) => send('DELETE', `/plan/links/${encodeURIComponent(taskId)}`);
/** Merges a duplicate into the survivor through the board's existing merge. */
export const mergeDuplicate = (projectId: string, taskId: string, intoTaskId: string) =>
  send('POST', `/boards/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/merge`, { intoTaskId });
