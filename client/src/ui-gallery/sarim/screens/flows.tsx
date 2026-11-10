/**
 * SARIM edition, area `flows`: the list of the flows (sarim-flows), one flow
 * with its steps and the live cards at each, and one step (sarim-flow). Search
 * finds flows and steps. The wiring is in `flows/`, the state of the flows
 * (pause, tries) in `../model/flows.ts`.
 */
import { ListChecks } from 'lucide-react';
import type { AreaModule, Params, ScreenCtx, SearchEntry } from '../../app/kit';
import { world } from '../world';
import { flowIcon, opsFlowById } from '../model/flows';
import { stepActor, actorName } from '../model/who';
import { SP } from '../paths';
import { FlowsListPlace } from './flows/list-place';
import { FlowPlace } from './flows/flow-place';
import { StepPlace } from './flows/step-place';
import { stepTitle } from './flows/common';

/** One tab for the section, named for it: a flow's name is longer than the tab and the page says which flow it is. */
const flowTab = (_p: Params, ctx: ScreenCtx) => ({ label: ctx.copy.sarimWork.flows.title, kind: 'flows' as const });
const flowTitle = (p: Params, ctx: ScreenCtx) => opsFlowById(p.flow)?.name ?? ctx.copy.sarimWork.flows.notFound;

function search(ctx: ScreenCtx): SearchEntry[] {
  const f = ctx.copy.sarimWork.flows;
  return world().opsFlows.flatMap((flow): SearchEntry[] => [
    {
      id: `sarim-flow:${flow.id}`,
      group: f.searchFlows,
      title: flow.name,
      detail: `${world().people.areaLabel[flow.area]} · ${flow.trigger}`,
      keywords: [...flow.programs, ...flow.steps.map((s) => s.title)].join(' '),
      path: SP.flow(flow.id),
      icon: flowIcon(flow.id),
      needs: 'view:flows',
    },
    ...flow.steps.map((s, i): SearchEntry => ({
      id: `sarim-step:${flow.id}:${s.id}`,
      group: f.searchSteps,
      title: s.title,
      detail: `${flow.name} · ${f.step.crumb(String(i + 1))}`,
      keywords: actorName(stepActor(s.actor, ctx.copy)),
      path: SP.flowStep(flow.id, s.id),
      icon: ListChecks,
      needs: 'view:flows',
    })),
  ]);
}

export const SARIM_FLOWS_AREA: AreaModule = {
  screens: [
    {
      id: 'sarim-flows', path: '/flussi', org: world().key, nav: 'flows', samples: [SP.flows()], needs: 'view:flows',
      tabKey: () => 'sarim-flows',
      tab: (_p, ctx) => ({ label: ctx.copy.sarimWork.flows.title, kind: 'flows' }),
      title: (_p, ctx) => ctx.copy.sarimWork.flows.title,
      render: (_p, ctx) => <FlowsListPlace ctx={ctx} />,
    },
    {
      id: 'sarim-flow', path: '/flussi/:flow', org: world().key, nav: 'flows', needs: 'view:flows',
      samples: world().samples.flows.map((id) => SP.flow(id)),
      tabKey: () => 'sarim-flows',
      tab: flowTab,
      title: flowTitle,
      render: (p, ctx) => <FlowPlace ctx={ctx} id={p.flow} />,
    },
    {
      id: 'sarim-flow', path: '/flussi/:flow/passo/:step', org: world().key, nav: 'flows', needs: 'view:flows',
      samples: world().samples.flowSteps.map(([flow, step]) => SP.flowStep(flow, step)),
      tabKey: () => 'sarim-flows',
      tab: flowTab,
      title: (p, ctx) => {
        const step = stepTitle(opsFlowById(p.flow), p.step);
        return step ? `${flowTitle(p, ctx)} · ${step}` : flowTitle(p, ctx);
      },
      render: (p, ctx) => <StepPlace ctx={ctx} flowId={p.flow} stepId={p.step} />,
    },
  ],
  search,
};
