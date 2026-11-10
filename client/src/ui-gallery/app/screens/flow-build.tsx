/**
 * The places of the `flow-build` area: the list of flows (n01), starting one
 * (n02), a flow built from a chat (n03), a flow as steps (w01) and by office
 * (w03), and the interview that captures what a person knows (o02). The state
 * is the `flows` slice (`flow-build/model.ts`); see `../kit.ts` for the contract.
 */
import { ListChecks, Workflow } from 'lucide-react';
import { OFFICE_LABEL } from '../../../ui/fixtures/org/people';
import { FLOWS } from '../../../ui/fixtures/org/flows';
import type { AreaModule, ScreenCtx, ScreenDef, SearchEntry } from '../kit';
import { P } from '../paths';
import { InterviewPage, InvoiceChatPage } from './flow-build/chat';
import { FlowPage } from './flow-build/detail';
import { FlowListPage } from './flow-build/list';
import { NewFlowPage } from './flow-build/start';
import { EMPTY_FLOWS, editedSteps, findFlow, flowsOf, type FlowsSlice } from './flow-build/model';

/** Reads the area's slice without subscribing: for titles and search, which are not components. */
const sliceOf = (ctx: ScreenCtx): FlowsSlice => (ctx.state.slices.flows as FlowsSlice | undefined) ?? EMPTY_FLOWS;

const flowName = (flow: string, ctx: ScreenCtx) => findFlow(sliceOf(ctx), flow)?.name ?? ctx.copy.flows.root;

/** Every flow of the Nocera organization with a page: the examples first. */
const SAMPLE_FLOWS = FLOWS.filter((f) => f.org === 'nocera').map((f) => P.flow(f.id));

const flowTab = (p: Record<string, string>, ctx: ScreenCtx) => ({ key: `flow:${p.flow}`, label: flowName(p.flow, ctx), kind: 'flows' as const });

const screens: ScreenDef[] = [
  {
    id: 'n01', path: '/flussi', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: [P.flows()],
    title: (_p, ctx) => ctx.copy.flows.root,
    render: (_p, ctx) => <FlowListPage ctx={ctx} />,
  },
  {
    id: 'n02', path: '/flussi/nuovo', org: 'nocera', nav: 'flows', needs: 'edit:structure', samples: [P.flowNew()],
    tabKey: () => 'flows',
    tab: (_p, ctx) => ({ label: ctx.copy.flows.root, kind: 'flows' }),
    title: (_p, ctx) => ctx.copy.flowBuild.start.title,
    render: (_p, ctx) => <NewFlowPage ctx={ctx} />,
  },
  {
    id: 'n03', path: '/chat/nuovo-flusso-fatture', org: 'nocera', nav: 'chat:nuovo-flusso-fatture', needs: 'view:flows', samples: [P.chat('nuovo-flusso-fatture')],
    tabKey: () => 'chat:nuovo-flusso-fatture',
    tab: (_p, ctx) => ({ label: ctx.copy.flowBuild.chat.title, kind: 'chat' }),
    title: (_p, ctx) => ctx.copy.flowBuild.chat.title,
    render: (_p, ctx) => <InvoiceChatPage ctx={ctx} />,
  },
  {
    id: 'o02', path: '/chat/intervista-catasto', org: 'nocera', nav: 'chat:intervista-catasto', needs: 'view:flows', samples: [P.chat('intervista-catasto')],
    tabKey: () => 'chat:intervista-catasto',
    tab: (_p, ctx) => ({ label: ctx.copy.flowBuild.interview.tabTitle, kind: 'chat' }),
    title: (_p, ctx) => ctx.copy.flowBuild.interview.tabTitle,
    render: (_p, ctx) => <InterviewPage ctx={ctx} />,
  },
  {
    id: 'w01', path: '/flussi/:flow', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: SAMPLE_FLOWS,
    tab: flowTab,
    title: (p, ctx) => flowName(p.flow, ctx),
    render: (p, ctx) => <FlowPage key={p.flow} ctx={ctx} flowId={p.flow} view="steps" />,
  },
  {
    id: 'w03', path: '/flussi/:flow/uffici', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: [P.flowOffices('pec'), P.flowOffices('fatture')],
    tab: flowTab,
    title: (p, ctx) => ctx.copy.flowBuild.offices.title(flowName(p.flow, ctx)),
    render: (p, ctx) => <FlowPage key={p.flow} ctx={ctx} flowId={p.flow} view="byOffice" />,
  },
];

function search(ctx: ScreenCtx): SearchEntry[] {
  const t = ctx.copy.flowBuild.search;
  const slice = sliceOf(ctx);
  const out: SearchEntry[] = [];
  for (const f of flowsOf(slice, 'nocera')) {
    const steps = editedSteps(f, slice.edits[f.id]);
    out.push({
      id: `flow:${f.id}`, group: t.flows, title: f.name, detail: `${f.trigger} · ${OFFICE_LABEL[f.office]}`,
      keywords: [f.trigger, OFFICE_LABEL[f.office], ...steps.map((s) => s.label)].join(' '), path: P.flow(f.id), icon: Workflow, needs: 'view:flows',
    });
    for (const s of steps) {
      out.push({
        id: `step:${f.id}:${s.id}`, group: t.steps, title: s.label, detail: f.name, keywords: s.program, path: P.flowStep(f.id, s.id), icon: ListChecks, needs: 'view:flows',
      });
    }
  }
  return out;
}

export const FLOW_BUILD_AREA: AreaModule = { screens, search };
