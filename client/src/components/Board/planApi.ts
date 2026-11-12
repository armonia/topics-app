/**
 * Plan calls (`/api/plan`). The response types live in `shared/plan.ts`:
 * the client recomputes nothing, it only shows.
 */
import { apiFetch } from '../../lib/shell/net';
import type { PlanTree } from '../../../../shared/plan';
export type {
  PlanArea, PlanCard, PlanMilestone, PlanProgress, PlanProject, PlanSignal, PlanTree,
} from '../../../../shared/plan';

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api${path}`, {
    method,
    // The plan view is part of the interface: `apiFetch` alone does not add
    // this marker (unlike `boardApi.req`), so without it a card moved from
    // here would read as an API call instead of a person's click.
    headers: { 'X-Topics-Action-Origin': 'interface', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const fetchPlan = (includeDone: boolean) => send<PlanTree>('GET', `/plan${includeDone ? '?includeDone=1' : ''}`);
export const createArea = (projectId: string, name: string) => send('POST', '/plan/areas', { projectId, name });
export const createMilestone = (input: {
  areaId: string; title: string; expectedResult?: string; completionCriteria?: string; owner?: string; targetDate?: string;
}) => send('POST', '/plan/milestones', input);
export const updateMilestone = (id: string, patch: { owner?: string; targetDate?: string }) => send('PATCH', `/plan/milestones/${encodeURIComponent(id)}`, patch);
export const linkCard = (taskId: string, milestoneId: string) => send('PUT', `/plan/links/${encodeURIComponent(taskId)}`, { milestoneId });
/** Merges a duplicate into the survivor through the board's existing merge. */
export const mergeDuplicate = (projectId: string, taskId: string, intoTaskId: string) =>
  send('POST', `/boards/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/merge`, { intoTaskId });
