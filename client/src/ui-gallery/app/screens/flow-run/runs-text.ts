/**
 * What the runs of a flow say about themselves: who has the run, how long it
 * took, and its status in words. Plain functions, shared by the list and the page of a run.
 */
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { RunActor } from '../../../../ui/flowrun/model';
import type { ScreenCtx } from '../../kit';
import { configOf, clockTime, dayOf, minutesBetween, shortDate, stepTime, addMinutes, type LiveRun, type OverrideMap } from './data';
import { DEMO_TODAY } from '../../../../ui/fixtures/org/clock';
import { duration } from './labels';

const OFFICE_COLOR: Record<string, string> = { protocollo: '#2f8f5b', legale: '#7a5af5', direzione: '#c2410c' };
const OFFICE_MONOGRAM: Record<string, string> = { protocollo: 'OP', legale: 'AV', direzione: 'DIR' };

export function officeActor(office: string): RunActor {
  const label = OFFICE_LABEL[office as keyof typeof OFFICE_LABEL] ?? office;
  return { kind: 'person', text: OFFICE_MONOGRAM[office] ?? label.slice(0, 2).toUpperCase(), color: OFFICE_COLOR[office] ?? '#64748b' };
}

/** Who has the run: the person it waits on, or the kind of step that last worked on it. */
export function actorOf(flow: FlowSeed, run: LiveRun): RunActor {
  const at = flow.steps.find((s) => s.id === run.stepId);
  if (run.status === 'archived') return { kind: 'rule' };
  if (run.status === 'person' && at) return officeActor(at.office ?? flow.office);
  if (run.status === 'done' && run.personStepId) {
    const p = flow.steps.find((s) => s.id === run.personStepId);
    return officeActor(p?.office ?? flow.office);
  }
  const kind = at?.kind;
  if (kind === 'ai' || kind === 'classify') return { kind: 'ai' };
  if (kind === 'rule') return { kind: 'rule' };
  return { kind: 'robot' };
}

export function runDuration(ctx: ScreenCtx, run: LiveRun): { text: string; live: boolean } {
  const live = run.status === 'running' || run.status === 'person' || run.status === 'blocked' || run.status === 'error';
  if (live) return { text: duration(ctx.copy, minutesBetween(run.resumedAt ?? run.arrived, ctx.now) * 60), live: true };
  if (run.live.finishedAt) return { text: duration(ctx.copy, minutesBetween(run.arrived, run.live.finishedAt) * 60), live: false };
  return { text: duration(ctx.copy, run.durationSec), live: false };
}

/**
 * When the person a run waits on should answer: the time, the day when it is not today, and whether it is
 * already gone. The list, the run's chip and its side panel all say it from here.
 */
export function personDue(ctx: ScreenCtx, flow: FlowSeed, run: LiveRun, activeOv: OverrideMap): { time: string; day?: string; late: boolean } {
  const at = flow.steps.find((s) => s.id === run.stepId);
  const idx = run.path.indexOf(run.stepId);
  const cfg = at ? configOf(flow, at, [activeOv]) : undefined;
  const hours = cfg?.type === 'generic' ? cfg.hours : 4;
  const until = addMinutes(stepTime(run, flow, Math.max(0, idx)), hours * 60);
  return { time: clockTime(until), day: dayOf(until) === DEMO_TODAY ? undefined : shortDate(until), late: Date.parse(until) < Date.parse(ctx.now) };
}

export function statusText(ctx: ScreenCtx, flow: FlowSeed, run: LiveRun, activeOv: OverrideMap): string {
  const t = ctx.copy.flowRun.runs.status;
  const at = flow.steps.find((s) => s.id === run.stepId);
  switch (run.status) {
    case 'running': return t.running;
    case 'person': {
      // A time due on another day says the day too, and a time already gone says the wait is late.
      const due = personDue(ctx, flow, run, activeOv);
      return due.late ? t.personLate(due.time, due.day) : t.person(due.time, due.day);
    }
    case 'blocked': return t.blocked(at?.program ?? '');
    case 'error': return t.error(at?.program ?? '');
    case 'archived': return t.archived;
    default:
      // The attempt that went through comes after the failed ones; a run freed behind a stopped one had none of its own.
      return run.live.finishedAt && run.attempts > 0 ? t.doneAfter(run.attempts + 1) : t.done;
  }
}
