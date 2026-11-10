/**
 * Pieces every screen of the area uses: the state of a flow's versions, the
 * switcher of the flow's views, and the way to a step, a run, a version.
 */
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import type { FlowViewId } from '../../../../ui/flowrun/model';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { HALLEY_VAULT } from '../../store/vault';
import { RUNS_SLICE, initialSlice, type FlowRunSlice, type RunOverrides } from './data';

export const VIEWS: FlowViewId[] = ['steps', 'byOffice', 'runs', 'tests', 'versions', 'log'];

export function viewPath(flow: string, v: FlowViewId): string {
  switch (v) {
    case 'steps': return P.flow(flow);
    case 'byOffice': return P.flowOffices(flow);
    case 'runs': return P.flowRuns(flow);
    case 'tests': return P.flowTest(flow);
    case 'versions': return P.flowVersions(flow);
    case 'log': return P.settings('registro');
  }
}

const INITIAL = new Map<string, FlowRunSlice>();

/** The versions and edits of a flow: persisted in the state of the preview. */
export function useFlowSlice(ctx: ScreenCtx, flow: FlowSeed) {
  let initial = INITIAL.get(flow.id);
  if (!initial) {
    initial = initialSlice(flow, ctx.now);
    INITIAL.set(flow.id, initial);
  }
  return ctx.slice<FlowRunSlice>(`flowRun:${flow.id}`, initial);
}

/** What happened on the runs since the preview started. */
export function useRunOverrides(ctx: ScreenCtx) {
  return ctx.slice<RunOverrides>(RUNS_SLICE, {});
}


export function credentialOf(vault: Record<string, string>, ref: string): { state: 'valid' | 'expired'; updatedAt?: string } {
  if (vault[ref]) return { state: 'valid', updatedAt: vault[ref] };
  return { state: ref === HALLEY_VAULT ? 'expired' : 'valid' };
}


import type { JobState } from '../../kit';
import type { JobView } from '../../../../ui/flowrun/model';

export function toJobView(j: JobState | undefined): JobView | undefined {
  if (!j) return undefined;
  return { title: j.title, progress: j.progress, current: j.current, status: j.status, done: j.done, failed: j.failed };
}
