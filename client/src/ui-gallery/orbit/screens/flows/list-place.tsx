/**
 * «Flussi» of the ORBIT edition (orbit-flows): the eight flows with their (allow-italian: quotes the Italian interface)
 * state (a paused flow says so), what starts them, the monthly estimate, the
 * programs, how many steps an agent does and where their live cards stand,
 * step by step. Narrowed with the one filter bar of every list (team, state,
 * program, agent); the states are saved filters. Every count comes from
 * `liveCards` through `model/flows.ts`.
 */
import { useMemo } from 'react';
import { Bot, CircleDot, Plug, Users } from 'lucide-react';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import type { UiCopy } from '../../../../ui/copy/types';
import type { FlowRowModel, FlowStatModel } from '../../../../ui/orbit/work-model';
import { OpsFlowsList } from '../../../../ui/orbit/OpsFlowsList';
import type { OpsFlow } from '../../../../ui/fixtures/orbit-org/types';
import { agentById, world } from '../../world';
import { stuckCards } from '../../model/stages';
import { liveCards } from '../../model/live';
import { agentStepCount, agentsInHand, cardsAtStep, flowAgents, flowCards, flowIcon, flowsSlice, openCards, runningFlows } from '../../model/flows';
import { thousands } from '../../model/who';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { capital, flowStatus } from './common';

type FlowState = 'active' | 'testing' | 'draft' | 'paused';

/** A flow with whether it is paused, which is kept apart from the flow. */
interface FlowItem {
  flow: OpsFlow;
  paused: boolean;
}

/** Where a flow stands: a paused flow is paused whatever its state. */
function stateOf(item: FlowItem): FlowState {
  if (item.paused) return 'paused';
  if (item.flow.status === 'attivo') return 'active'; // allow-italian: status code, compared by value
  return item.flow.status === 'collaudo' ? 'testing' : 'draft'; // allow-italian: status code, compared by value
}

function schemaFor(copy: UiCopy): FilterSchema<FlowItem> {
  const f = copy.orbitWork.flows;
  return {
    text: ({ flow }) => [flow.name, flow.trigger, world().people.areaLabel[flow.area], ...flow.programs, ...flow.steps.map((s) => s.title)].join(' '),
    fields: [
      { id: 'team', label: f.fields.team, icon: Users, kind: 'choice', get: ({ flow }) => flow.area, valueLabel: (v) => world().people.areaLabel[v as OpsFlow['area']] ?? v },
      { id: 'state', label: f.fields.state, icon: CircleDot, kind: 'choice', get: (item) => stateOf(item), valueLabel: (v) => f.status[v as FlowState], order: ['active', 'testing', 'paused', 'draft'] },
      { id: 'program', label: f.fields.program, icon: Plug, kind: 'choice', get: ({ flow }) => flow.programs },
      { id: 'agent', label: f.fields.agent, icon: Bot, kind: 'choice', get: ({ flow }) => flowAgents(flow), valueLabel: (v) => agentById(v)?.name ?? v },
    ],
  };
}

export function FlowsListPlace({ ctx }: { ctx: ScreenCtx }) {
  const f = ctx.copy.orbitWork.flows;
  const cards = liveCards(ctx.state);
  const { paused } = flowsSlice(ctx.state);
  const items = useMemo<FlowItem[]>(() => world().opsFlows.map((flow) => ({ flow, paused: Boolean(paused[flow.id]) })), [paused]);
  const schema = useMemo(() => schemaFor(ctx.copy), [ctx.copy]);
  /* The states the list used to have as tabs, kept as saved filters. */
  const presets = useMemo<SavedFilter[]>(() => (['active', 'testing', 'paused'] as const).map((state, i) => ({
    id: state, name: f.status[state], tokens: [{ id: `p${i + 1}`, field: 'state', op: 'is', value: state }],
  })), [f]);
  const list = useListFilters(ctx, { key: 'orbit.flows.filters', items, schema, presets });

  const rows: FlowRowModel[] = list.items.map(({ flow, paused: isOff }) => {
    const own = flowCards(cards, flow.id);
    const open = openCards(own).length;
    const stuck = stuckCards(own, ctx.now).length;
    return {
      id: flow.id,
      name: flow.name,
      icon: flowIcon(flow.id),
      outcome: flow.outcome,
      meta: f.versionSteps(flow.version, flow.steps.length),
      status: flowStatus(flow, isOff, ctx),
      paused: isOff,
      area: world().people.areaLabel[flow.area],
      trigger: capital(flow.trigger),
      perMonth: thousands(flow.perMonth),
      programs: flow.programs,
      agents: f.agentSteps(agentStepCount(flow), flow.steps.length),
      /* One cell per step, as many as the flow page lists. The closing step holds the cards already in «Fatto», which «N aperte» leaves out: its cell is marked apart, so the others add up to the open cards. (allow-italian: quotes the Italian interface) */
      steps: flow.steps.map((s, i) => {
        const n = cardsAtStep(cards, flow, s.id).length;
        const isLast = s.stage === 'fatto'; // allow-italian: stage id, compared by value
        return { id: s.id, n: String(i + 1), count: n, hint: isLast ? f.stepDone(String(i + 1), s.title, n) : f.stepCount(String(i + 1), s.title, n), done: isLast || undefined };
      }),
      open: open ? f.openCards(open) : f.noCards,
      stuck: stuck ? f.stuck(stuck) : undefined,
      onOpen: () => ctx.go(SP.flow(flow.id)),
    };
  });

  const running = runningFlows(ctx.state).length;
  const testing = items.filter((item) => stateOf(item) === 'testing').length;
  const pausedCount = items.filter((item) => item.paused).length;
  const stuckAll = stuckCards(cards, ctx.now).length;
  /* The cards are the sidebar's «al lavoro»; one agent can hold more than one, so the agents are counted apart. (allow-italian: quotes the Italian interface) */
  const working = agentsInHand(cards);
  const busy = new Set(working.map((c) => c.worker.id)).size;
  const stats: FlowStatModel[] = [
    { id: 'running', label: f.stats.running, value: running, detail: f.stats.runningDetail(testing, pausedCount) },
    { id: 'open', label: f.stats.open, value: openCards(cards).length, detail: f.stats.openDetail },
    { id: 'stuck', label: f.stats.stuck, value: stuckAll, detail: f.stats.stuckDetail, tone: stuckAll ? 'red' : undefined },
    { id: 'agents', label: f.stats.agents, value: working.length, detail: f.stats.agentsDetail(busy, world().people.agents.length) },
  ];

  const count = f.count(world().opsFlows.length);
  return <OpsFlowsList rows={rows} stats={stats} filters={list.bar} count={count} copy={ctx.copy} phone={ctx.phone} crumbs={orgCrumbs(ctx, [{ label: f.title, detail: count }])} />;
}
