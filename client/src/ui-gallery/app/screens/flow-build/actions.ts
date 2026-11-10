/**
 * What changes the flows of the preview: making one, switching it off or on,
 * copying it. Each action writes to the `flows` slice, adds a line to the log
 * that cannot be edited and tells the person with a toast that leads on.
 */
import type { FlowSeed, FlowStepSeed, Office } from '../../../../ui/fixtures/org/types';
import { DEMO_TODAY } from '../../../../ui/fixtures/org/clock';
import type { StepDetail } from '../../../../ui/fixtures/flows';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { EMPTY_FLOWS, detailsOf, editedSteps, type CreatedFlow, type FlowsSlice, type FlowStatus } from './model';

export type SetSlice = (fn: (prev: FlowsSlice) => FlowsSlice) => void;

export function useFlowsSlice(ctx: ScreenCtx) {
  return ctx.slice<FlowsSlice>('flows', EMPTY_FLOWS);
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

export interface NewFlowInput {
  name: string;
  trigger: string;
  office: Office;
  steps: FlowStepSeed[];
  origin: CreatedFlow['origin'];
  from?: string;
  details?: Record<string, StepDetail>;
  triggerNote?: string;
}

/** Adds a flow as a draft, logs it and says so; returns its id so the caller can open it. */
export function createFlow(ctx: ScreenCtx, slice: FlowsSlice, setSlice: SetSlice, input: NewFlowInput, quiet = false): string {
  const t = ctx.copy.flowBuild;
  const id = `nuovo-${slug(input.name) || 'flusso'}-${slice.created.length + 1}`; // allow-italian: part of an address, not shown
  const flow: CreatedFlow = {
    id, org: 'nocera', name: input.name, trigger: input.trigger, office: input.office,
    status: 'bozza', version: 1, perMonth: 0, steps: input.steps,
    from: input.from, origin: input.origin, details: input.details ?? {}, triggerNote: input.triggerNote, createdAt: DEMO_TODAY,
  };
  setSlice((s) => ({ ...s, created: [...s.created, flow] }));
  ctx.log(t.log.created(input.name), 'structure', P.flow(id));
  if (!quiet) ctx.toast({ tone: 'ok', title: t.toast.created(input.name), body: t.toast.createdBody, action: { label: t.toast.open, path: P.flow(id) } });
  return id;
}

/** A draft copy of a flow, with the steps as they stand now. */
export function duplicateFlow(ctx: ScreenCtx, slice: FlowsSlice, setSlice: SetSlice, flow: FlowSeed & Partial<CreatedFlow>): string {
  const t = ctx.copy.flowBuild;
  const steps = editedSteps(flow, slice.edits[flow.id]);
  const id = createFlow(ctx, slice, setSlice, {
    name: t.list.copyName(flow.name), trigger: flow.trigger, office: flow.office, steps, origin: 'duplicate', from: flow.from ?? flow.id, details: detailsOf(flow),
  }, true);
  ctx.toast({ tone: 'ok', title: t.toast.duplicated(flow.name), body: t.toast.duplicatedBody, action: { label: t.toast.open, path: P.flow(id) } });
  return id;
}

/** Turning a flow off or on asks first: a flow that is off stops reading what arrives. */
export function askSwitch(ctx: ScreenCtx, setSlice: SetSlice, flow: FlowSeed, to: FlowStatus) {
  const t = ctx.copy.flowBuild;
  const off = to === 'spento'; // allow-italian: state identifier, not shown
  ctx.confirm({
    title: off ? t.confirm.offTitle(flow.name) : t.confirm.onTitle(flow.name),
    body: off ? t.confirm.offBody : t.confirm.onBody,
    confirmLabel: off ? t.confirm.off : t.confirm.on,
    tone: off ? 'danger' : 'primary',
    onConfirm: () => {
      setSlice((s) => ({ ...s, status: { ...s.status, [flow.id]: to } }));
      ctx.log(off ? t.log.off(flow.name) : t.log.on(flow.name), 'structure', P.flow(flow.id));
      ctx.toast({ tone: off ? 'warn' : 'ok', title: off ? t.toast.off(flow.name) : t.toast.on(flow.name), action: { label: t.toast.open, path: P.flow(flow.id) } });
    },
  });
}
