/**
 * The places of the `flow-run` area: a step as its own page (w02 classify, n05
 * AI, n06 rule, n07 robot, w01 for the others), the versions of a flow (n09),
 * its runs (n10), one run (n11) and how an AI step decides (g03). The state is
 * the flow's slice and the runs' overrides (`flow-run/shared.tsx`); see
 * `../kit.ts` for the contract.
 */
import { AlertTriangle, History } from 'lucide-react';
import { EmptyState } from '../../../ui/primitives/EmptyState';
import { Button } from '../../../ui/primitives/Button';
import { FLOWS } from '../../../ui/fixtures/org/flows';
import { STUCK_RUN, runsOf } from '../../../ui/fixtures/flowrun';
import type { AreaModule, ScreenCtx, ScreenDef, SearchEntry } from '../kit';
import { P } from '../paths';
import { DecidesScreen } from './flow-run/decides';
import { RunScreen } from './flow-run/run';
import { RunsScreen } from './flow-run/runs';
import { StepScreen } from './flow-run/step';
import { VersionsScreen } from './flow-run/versions';
import { RUNS_SLICE, flowById, liveRun, stepById, type RunOverrides } from './flow-run/data';

const flowTab = (p: Record<string, string>) => ({ key: `flow:${p.flow}`, label: flowById(p.flow)?.name ?? p.flow, kind: 'flows' as const });
const flowName = (flow: string, ctx: ScreenCtx) => flowById(flow)?.name ?? ctx.copy.flows.root;

const noFlow = (ctx: ScreenCtx) => (
  <EmptyState
    title={ctx.copy.flowRun.screen.notFoundFlow}
    action={<Button variant="primary" onClick={() => ctx.go(P.flows())}>{ctx.copy.flowRun.screen.backToFlows}</Button>}
  >
    {ctx.copy.flowRun.screen.notFoundFlowBody}
  </EmptyState>
);

const STEP_SCREEN: Record<string, string> = { classify: 'w02', ai: 'n05', rule: 'n06', robot: 'n07' };

const stepOf = (p: Record<string, string>) => {
  const flow = flowById(p.flow);
  return flow ? stepById(flow, p.step) : undefined;
};

const screens: ScreenDef[] = [
  {
    id: 'w02', path: '/flussi/:flow/passo/:step', org: 'nocera', nav: 'flows', needs: 'view:flows',
    samples: [P.flowStep('pec', 's2'), P.flowStep('pec', 'a'), P.flowStep('pec', 's1'), P.flowStep('pec', 'e'), P.flowStep('pec', 'd')],
    tab: flowTab,
    title: (p, ctx) => {
      const step = stepOf(p);
      return step ? `${flowName(p.flow, ctx)} · ${step.label}` : flowName(p.flow, ctx);
    },
    screenId: (p) => STEP_SCREEN[stepOf(p)?.kind ?? ''] ?? 'w01',
    render: (p, ctx) => {
      const flow = flowById(p.flow);
      if (!flow) return noFlow(ctx);
      const step = stepById(flow, p.step);
      if (!step) {
        return (
          <EmptyState
            title={ctx.copy.flowRun.screen.notFoundStep}
            action={<Button variant="primary" onClick={() => ctx.go(P.flow(flow.id))}>{ctx.copy.flowRun.screen.backToFlow}</Button>}
          >
            {ctx.copy.flowRun.screen.notFoundStepBody}
          </EmptyState>
        );
      }
      return <StepScreen key={`${flow.id}:${step.id}`} ctx={ctx} flow={flow} step={step} />;
    },
  },
  {
    id: 'n09', path: '/flussi/:flow/versioni', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: [P.flowVersions('pec'), P.flowVersions('fatture')],
    tab: flowTab,
    title: (p, ctx) => ctx.copy.flowRun.versions.title(flowName(p.flow, ctx)),
    render: (p, ctx) => {
      const flow = flowById(p.flow);
      return flow ? <VersionsScreen key={flow.id} ctx={ctx} flow={flow} /> : noFlow(ctx);
    },
  },
  {
    id: 'n10', path: '/flussi/:flow/esecuzioni', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: [P.flowRuns('pec'), P.flowRuns('accesso')],
    tab: flowTab,
    title: (p, ctx) => ctx.copy.flowRun.runs.title(flowName(p.flow, ctx)),
    render: (p, ctx) => {
      const flow = flowById(p.flow);
      return flow ? <RunsScreen key={flow.id} ctx={ctx} flow={flow} /> : noFlow(ctx);
    },
  },
  {
    id: 'n11', path: '/flussi/:flow/esecuzioni/:run', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: [P.flowRun(STUCK_RUN.flow, STUCK_RUN.id), P.flowRun('pec', 'e-0398')],
    tab: flowTab,
    title: (p, ctx) => ctx.copy.flowRun.run.crumb(p.run),
    render: (p, ctx) => {
      const flow = flowById(p.flow);
      return flow ? <RunScreen key={`${flow.id}:${p.run}`} ctx={ctx} flow={flow} runId={p.run} /> : noFlow(ctx);
    },
  },
  {
    id: 'g03', path: '/flussi/:flow/come-decide', org: 'nocera', nav: 'flows', needs: 'view:flows', samples: [P.flowDecides('pec'), P.flowDecides('accesso')],
    tab: flowTab,
    title: (p, ctx) => ctx.copy.flowRun.decides.title(flowName(p.flow, ctx)),
    render: (p, ctx) => {
      const flow = flowById(p.flow);
      return flow ? <DecidesScreen key={flow.id} ctx={ctx} flow={flow} /> : noFlow(ctx);
    },
  },
];

function search(ctx: ScreenCtx): SearchEntry[] {
  const t = ctx.copy.flowRun.search;
  const out: SearchEntry[] = [];
  // The search reads the runs as the screens show them: once the robot went on, the run is no longer the stopped one.
  const [ov] = ctx.slice<RunOverrides>(RUNS_SLICE, {});
  for (const f of FLOWS.filter((x) => x.org === 'nocera')) {
    for (const r of runsOf(f.id)) {
      const stuck = r.flow === STUCK_RUN.flow && r.id === STUCK_RUN.id && liveRun(r, ov).status === 'error';
      out.push({
        id: `run:${f.id}:${r.id}`, group: t.group, title: stuck ? t.stuck(r.id) : r.id, detail: stuck ? t.stuckDetail : t.runDetail(f.name),
        keywords: [r.caseId, r.title, f.name, stuck ? t.keywordsStuck : ''].join(' '),
        path: P.flowRun(f.id, r.id), icon: stuck ? AlertTriangle : History, needs: 'view:flows',
      });
    }
  }
  return out;
}

export const FLOW_RUN_AREA: AreaModule = { screens, search };
