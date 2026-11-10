/**
 * One step of a SARIM flow (sarim-flow, `/flussi/:flow/passo/:step`): who (allow-italian: quotes the Italian interface)
 * does it and what, what it reads and produces (`fixtures/sarim-org/step-data.ts`),
 * the state of «Da fare» it stands in, the live cards there, and for a step (allow-italian: quotes the Italian interface)
 * of an agent the person who checks it next.
 */
import { ListChecks } from 'lucide-react';
import type { ScreenCtx } from '../../../app/kit';
import type { StepPageModel } from '../../../../ui/sarim/work-model';
import { OpsStepScreen } from '../../../../ui/sarim/OpsStepScreen';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import type { OpsFlowStep } from '../../../../ui/fixtures/sarim-org/types';
import { agentById, personaById, world } from '../../world';
import { isStuck } from '../../model/stages';
import { liveCards } from '../../model/live';
import { cardsAtStep, opsFlowById, personAfter } from '../../model/flows';
import { openDaFare } from '../../model/dafare';
import { momentLabel, personActor, stepActor, workerActor } from '../../model/who';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { capital, noFlow } from './common';

/** What the actor of a step is, in one sentence: the agent's job, the person's role, the program, the rule. */
function doesOf(step: OpsFlowStep, ctx: ScreenCtx): string {
  const s = ctx.copy.sarimWork.flows.step;
  switch (step.actor.kind) {
    case 'rule': return s.ruleDoes;
    case 'program': return s.programDoes(step.actor.name);
    case 'agent': {
      const agent = agentById(step.actor.id);
      return agent ? `${capital(agent.does)}.` : step.title;
    }
    case 'person': {
      const person = personaById(step.actor.id);
      const role = world().people.roles.find((r) => r.id === person?.role);
      return person ? `${person.name}: ${role?.description ?? ''}` : step.title;
    }
  }
}

export function StepPlace({ ctx, flowId, stepId }: { ctx: ScreenCtx; flowId: string; stepId: string }) {
  const f = ctx.copy.sarimWork.flows;
  const flow = opsFlowById(flowId);
  if (!flow) return noFlow(ctx);
  const at = flow.steps.findIndex((s) => s.id === stepId);
  const step = flow.steps[at];
  if (!step) {
    return (
      <EmptyState icon={ListChecks} title={f.step.notFound} action={<Button variant="primary" onClick={() => ctx.go(SP.flow(flow.id))}>{f.step.backToFlow}</Button>}>
        {f.step.notFoundBody}
      </EmptyState>
    );
  }
  const stage = world().stages.find((s) => s.id === step.stage);
  const stuckHours = flow.stuckAfterHours;
  const data = world().stepData[flow.id]?.[step.id] ?? { reads: [], produces: [] };
  const after = step.actor.kind === 'agent' ? personAfter(flow, step.id) : undefined;
  const go = (id: string) => () => ctx.go(SP.flowStep(flow.id, id));
  const prev = flow.steps[at - 1];
  const next = flow.steps[at + 1];

  const page: StepPageModel = {
    id: step.id,
    flow: flow.name,
    marker: String(at + 1),
    title: step.title,
    stage: { label: stage?.label ?? step.stage, hint: stage?.hint ?? '' },
    stops: step.stage === 'fatto' ? undefined : f.step.stopsAfter(stuckHours), // allow-italian: stage id, compared by value
    actor: stepActor(step.actor, ctx.copy),
    does: doesOf(step, ctx),
    reads: data.reads,
    produces: data.produces,
    cards: cardsAtStep(liveCards(ctx.state), flow, step.id).map((card) => ({
      id: card.id,
      title: card.title,
      detail: card.blocked ? `${card.detail} · ${card.blocked.reason}` : card.detail,
      worker: workerActor(card.worker),
      doing: card.worker.doing,
      since: momentLabel(card.worker.since, ctx.now, ctx.copy),
      reviewer: personActor(card.reviewer),
      stopped: isStuck(card, world().opsFlows, ctx.now) ? ctx.copy.sarimWork.flows.step.stopped : undefined,
      onOpen: () => ctx.go(SP.card(card.id)),
    })),
    after: step.actor.kind === 'agent' ? { next: after ? { actor: stepActor(after.actor, ctx.copy), step: `${flow.steps.indexOf(after) + 1}. ${after.title}`, onOpen: go(after.id) } : undefined } : undefined,
    nav: flow.steps.map((s, i) => ({ id: s.id, marker: String(i + 1), title: s.title, actor: stepActor(s.actor, ctx.copy), onOpen: go(s.id) })),
    onPrev: prev ? go(prev.id) : undefined,
    onNext: next ? go(next.id) : undefined,
    onBack: () => ctx.go(SP.flow(flow.id)),
    onColumn: () => openDaFare(ctx, { view: 'kanban', flow: flow.id, stage: step.stage }),
  };
  return <OpsStepScreen page={page} copy={ctx.copy} phone={ctx.phone} crumbs={orgCrumbs(ctx, [{ label: f.title, to: SP.flows() }, { label: flow.name, to: SP.flow(flow.id) }, { label: step.title, detail: f.step.crumb(String(at + 1)) }])} />;
}
