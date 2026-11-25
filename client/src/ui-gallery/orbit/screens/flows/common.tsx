/**
 * What the places of «Flussi» share: the state chip of a flow, a card as a (allow-italian: quotes the Italian interface)
 * small link, the empty place of a flow that is not there, the job id of a
 * try, the title of a step.
 */
import { Workflow } from 'lucide-react';
import type { ScreenCtx } from '../../../app/kit';
import type { CardLinkModel, FlowStatusModel } from '../../../../ui/orbit/work-model';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import type { OpsFlow, OrbitCard } from '../../../../ui/fixtures/orbit-org/types';
import { world } from '../../world';
import { isStuck } from '../../model/stages';
import { stageOf } from '../../model/live';
import { actorName, workerActor } from '../../model/who';
import { SP } from '../../paths';

/** The state chip of a flow; a paused flow reads «In pausa» whatever its state. (allow-italian: quotes the Italian interface) */
export function flowStatus(flow: OpsFlow, paused: boolean, ctx: ScreenCtx): FlowStatusModel {
  const s = ctx.copy.orbitWork.flows.status;
  if (paused) return { state: 'paused', text: s.paused, tone: 'amber' };
  if (flow.status === 'attivo') return { state: 'active', text: s.active, tone: 'green' }; // allow-italian: status code, compared by value
  if (flow.status === 'collaudo') return { state: 'testing', text: s.testing, tone: 'blue' }; // allow-italian: status code, compared by value
  return { state: 'draft', text: s.draft, tone: 'neutral' };
}

export const tryJobId = (flowId: string) => `orbit-flow-try-${flowId}`;

/** The first letter in capital: a trigger written in the middle of a sentence, shown as a title. */
export const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function cardLink(card: OrbitCard, ctx: ScreenCtx): CardLinkModel {
  const stage = world().stages.find((s) => s.id === stageOf(card))?.label ?? stageOf(card);
  return {
    id: card.id,
    title: card.title,
    hint: `${stage} · ${actorName(workerActor(card.worker))}${card.blocked ? ` · ${card.blocked.reason}` : ''}`,
    stopped: isStuck(card, world().opsFlows, ctx.now),
    onOpen: () => ctx.go(SP.card(card.id)),
  };
}

export function noFlow(ctx: ScreenCtx) {
  const f = ctx.copy.orbitWork.flows;
  return (
    <EmptyState icon={Workflow} title={f.notFound} action={<Button variant="primary" onClick={() => ctx.go(SP.flows())}>{f.backToFlows}</Button>}>
      {f.notFoundBody}
    </EmptyState>
  );
}

export function stepTitle(flow: OpsFlow | undefined, stepId: string): string | undefined {
  return flow?.steps.find((s) => s.id === stepId)?.title;
}

