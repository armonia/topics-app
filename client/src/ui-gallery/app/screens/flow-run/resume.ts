/**
 * A robot that can enter its program again: the run that stopped and the
 * runs waiting behind it on the same step go on together, as the run's
 * banner promises. The run's retry calls it at the end of its job; every
 * place that saves the Halley robot's password calls it at once, so the
 * runs, the sidebar and the program never disagree on whether it is stopped.
 */
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { RUNS_SLICE, clockTime, findRun, flowById, liveRunsOf, stepById, waitingWith, type RunOverrides } from './data';

/** What went on: the stopped run itself (unless someone had taken it over by hand) and how many behind it. */
export interface Resumed {
  stopped: boolean;
  freed: number;
}

export function resumeStopped(ctx: ScreenCtx, flowId: string, runId: string, text: { run: string; freed: string }, program: string): Resumed {
  const [ov, setOv] = ctx.slice<RunOverrides>(RUNS_SLICE, {});
  const run = findRun(flowId, runId, ov);
  const flow = flowById(flowId);
  if (!run || !flow) return { stopped: false, freed: 0 };
  // A stopped run taken over by hand is out of the way, but the runs behind it still wait for the robot.
  const stopped = run.status === 'error';
  const behind = waitingWith(run, liveRunsOf(flowId, ov));
  const targets = [...(stopped ? [run] : []), ...behind];
  if (!targets.length) return { stopped: false, freed: 0 };
  const now = ctx.now;
  setOv((prev) => {
    const next = { ...prev };
    for (const t of targets) {
      const o = next[t.id] ?? {};
      const events = [...(o.events ?? []), { at: clockTime(now), text: t.id === run.id ? text.run : text.freed }];
      const restarted = { restartedAt: now, restartedStep: t.stepId };
      // The robot's step is done. A run whose path goes on stops at its next step (2417 at the lawyer), it is not finished.
      const after = t.path[t.path.indexOf(t.stepId) + 1];
      const step = after ? stepById(flow, after) : undefined;
      // A run follows its case when the case is an example: unconfirmed (or never protocolled, like a WhatsApp report) it waits for the person with no number; confirmed, it takes the case's number.
      const example = CASES.find((c) => c.id === t.caseId);
      const person = t.personStepId && flow.steps.find((fs) => fs.id === t.personStepId);
      next[t.id] = example && example.status === 'da-confermare' && person
        ? { ...o, ...restarted, status: 'person', stepId: person.id, events }
        : step
          ? { ...o, ...restarted, status: step.kind === 'person' ? 'person' : 'running', stepId: step.id, events }
          : { ...o, ...restarted, status: 'done', finishedAt: now, protocol: example?.protocol?.number ?? `2026/00${18000 + t.n}`, events };
    }
    return next;
  });
  ctx.log(ctx.copy.flowRun.run.logResumed(targets.length, program), 'case', P.flowRun(flowId, run.id));
  return { stopped, freed: behind.length };
}
