/**
 * The form of a scheduled job as plain data: how a job becomes form fields and
 * the fields become the request. No React, so the rules are testable alone.
 */
import { cronPreset, presetCron, type CronPreset } from '../../lib/schedulePresets';
import { joinCommand, splitCommand, type JobAction, type JobInput, type JobSchedule, type ScheduledJob } from '../../lib/scheduledJobs';

export type WhenKind = CronPreset | 'every' | 'once';
export interface JobDraft {
  name: string;
  commandLine: string;
  /** Absolute directory the command runs in; empty when the project gives it. */
  cwd: string;
  /** The action as stored, so an edit keeps what the form does not show (input, environment, time limit). */
  base: Extract<JobAction, { kind: 'command' }> | null;
  whenKind: WhenKind;
  time: string;
  everyMinutes: string;
  onceAt: string;
  cron: string;
  timeZone: string;
  projectId: string;
  deliver: 'app' | 'owner';
}

export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome';

export function emptyDraft(): JobDraft {
  return {
    name: '', commandLine: '', cwd: '', base: null, whenKind: 'daily', time: '09:00',
    everyMinutes: '15', onceAt: '', cron: '0 9 * * 1', timeZone: browserTimeZone(), projectId: '', deliver: 'app',
  };
}

/** `datetime-local` wants the person's wall clock, not UTC. */
function localInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function draftOf(job: ScheduledJob): JobDraft {
  const draft = { ...emptyDraft(), name: job.name, projectId: job.projectId ?? '', deliver: job.deliver ? 'owner' as const : 'app' as const };
  if (job.action.kind === 'command') { draft.commandLine = joinCommand(job.action.argv); draft.cwd = job.action.cwd ?? ''; draft.base = job.action; }
  const schedule = job.schedule;
  if (schedule.kind === 'every') { draft.whenKind = 'every'; draft.everyMinutes = String(schedule.minutes); }
  else if (schedule.kind === 'at') { draft.whenKind = 'once'; draft.onceAt = localInput(schedule.at); }
  else {
    const found = cronPreset(schedule.expr);
    draft.whenKind = found.preset; draft.cron = schedule.expr; draft.timeZone = schedule.tz;
    if (found.time) draft.time = found.time;
  }
  return draft;
}

export function scheduleOf(draft: JobDraft): JobSchedule {
  if (draft.whenKind === 'every') return { kind: 'every', minutes: Number(draft.everyMinutes) };
  if (draft.whenKind === 'once') return { kind: 'at', at: draft.onceAt ? new Date(draft.onceAt).toISOString() : '' };
  const rule = draft.whenKind === 'custom' ? draft.cron : presetCron(draft.whenKind, draft.time);
  return { kind: 'cron', expr: rule, tz: draft.timeZone };
}

export function inputOf(draft: JobDraft): JobInput {
  return {
    name: draft.name.trim(),
    projectId: draft.projectId || null,
    schedule: scheduleOf(draft),
    action: { ...draft.base, kind: 'command', argv: splitCommand(draft.commandLine), cwd: draft.cwd.trim() || null },
    deliver: draft.deliver === 'owner' ? { to: 'owner' } : null,
  };
}
