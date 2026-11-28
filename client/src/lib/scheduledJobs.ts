/**
 * The client of `/api/scheduled-jobs`: the jobs Topics runs on its own (a
 * command, a board card), their runs, and the preview of when a schedule fires.
 * The preview is computed with `shared/schedule.ts`, the same module the server
 * schedules with, so the three occurrences shown are the ones that will happen.
 */
import { firstOccurrence, nextOccurrence, ScheduleError, validateSchedule, type JobSchedule } from '../../../shared/schedule';
import { apiFetch } from './shell/net';

export type { JobSchedule } from '../../../shared/schedule';

export type JobAction =
  | { kind: 'command'; argv: string[]; cwd?: string | null; stdin?: string | null; env?: Record<string, string>; timeoutSec?: number }
  | { kind: 'card'; text: string }
  | { kind: 'agent' };

export interface JobRun {
  id: string;
  scheduledFor: string;
  status: string;
  cause: string | null;
  reason: string | null;
  missedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  delivery: { state: string; detail: string | null } | null;
}

export interface ScheduledJob {
  id: string;
  name: string;
  projectId: string | null;
  schedule: JobSchedule;
  action: JobAction;
  deliver: unknown;
  enabled: boolean;
  nextRunAt: string | null;
  createdBy: string;
  lastRun: JobRun | null;
}

/** What the form writes; the server validates it again and says no in words. */
export interface JobInput {
  name: string;
  projectId: string | null;
  schedule: JobSchedule;
  action: JobAction;
  deliver: { to: 'owner' } | null;
  enabled?: boolean;
}

const BASE = '/api/scheduled-jobs';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const scheduledJobsApi = {
  list: () => call<{ jobs: ScheduledJob[]; startsPaused: boolean }>(BASE),
  create: (input: JobInput) => call<ScheduledJob>(BASE, { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: Partial<JobInput>) => call<ScheduledJob>(`${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => call<{ ok: boolean }>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runNow: (id: string) => call<unknown>(`${BASE}/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  runs: (id: string, limit = 20) => call<{ runs: JobRun[] }>(`${BASE}/${encodeURIComponent(id)}/runs?limit=${limit}`).then((r) => r.runs),
};

export type Preview = { ok: true; at: Date[] } | { ok: false; error: string };

/** The next `count` times a schedule fires, or why it cannot (a rule the server would refuse). */
export function previewOccurrences(schedule: JobSchedule, now: Date, isNew: boolean, count = 3): Preview {
  try {
    const valid = validateSchedule(schedule, { now, rejectPast: true, requireZone: true });
    const first = isNew ? firstOccurrence(valid, now) : nextOccurrence(valid, now);
    const at: Date[] = [];
    for (let next = first; next && at.length < count; next = nextOccurrence(valid, next)) at.push(next);
    return { ok: true, at };
  } catch (error) {
    if (error instanceof ScheduleError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Splits a command line into words; a quoted stretch stays one word. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) words.push(m[1] ?? m[2] ?? m[3] ?? '');
  return words;
}

/** The inverse of `splitCommand`, for showing an argv in one line. */
export function joinCommand(argv: string[]): string {
  return argv.map((word) => (/\s/.test(word) || word === '' ? `"${word}"` : word)).join(' ');
}
