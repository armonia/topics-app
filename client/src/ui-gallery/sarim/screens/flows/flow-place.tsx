/**
 * One SARIM flow (sarim-flow, `/flussi/:flow`): the one drawing of a flow (`FlowCanvas`) with the
 * live cards at each step, the way to the list of cards with the flow on the filter, the pause (needs
 * `edit:structure`) and the try on yesterday's cases (needs `run:tests`, a
 * job with progress whose result stays on the page). Where the flow splits by case (the reports
 * of SARIM, the PEC of the Consorzio) the lanes stand side by side inside the drawing and the
 * cards at the split step go to the lane they belong to.
 */
import type { ReactNode } from 'react';
import { Bot } from 'lucide-react';
import clsx from 'clsx';
import type { ScreenCtx } from '../../../app/kit';
import { OpsFlowScreen } from '../../../../ui/sarim/OpsFlowScreen';
import { ActorBadge, CardLink } from '../../../../ui/sarim/WorkParts';
import { Chip } from '../../../../ui/primitives/Chip';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../../../../ui/primitives/Panel';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { CanvasNode } from '../../../../ui/flows/model';
import type { OpsFlow, SarimCard } from '../../../../ui/fixtures/sarim-org/types';
import { agentById, personaById, world } from '../../world';
import { dayLabel } from '../../model/contracts';
import { opsCanvas, splitOf } from '../../model/canvas';
import { flowSummary } from '../../model/stages';
import { openDaFare } from '../../model/dafare';
import { liveCards } from '../../model/live';
import { FLOWS_INITIAL, FLOWS_SLICE, cardsAtStep, flowAgents, flowCards, flowIcon, flowsSlice, opsFlowById, tryCase, yesterdayCases, type FlowsSlice } from '../../model/flows';
import { momentLabel, thousands } from '../../model/who';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { capital, cardLink, flowStatus, noFlow, tryJobId } from './common';

/** Cards shown on a step before «altre N». (allow-italian: quotes the Italian interface) */
const CARDS_PER_STEP = 4;

function SideRows({ flow, ctx }: { flow: OpsFlow; ctx: ScreenCtx }) {
  const f = ctx.copy.sarimWork.flows;
  const side = f.side;
  const test = f.test;
  const all = liveCards(ctx.state);
  const cards = flowCards(all, flow.id);
  /* The counts of the flow the rows open, so a number here is the number of cards the column shows. */
  const summary = flowSummary(all, flow.id, ctx.now);
  const last = flowsSlice(ctx.state).tries[flow.id];
  const look = last ? last.cases.filter((c) => c.low.length).length : 0;
  const byName = last ? personaById(last.by)?.short ?? last.by : '';
  return (
    <SidePanel width={340}>
      <PanelHeading tag={side.tag} tagIcon={flowIcon(flow.id)} title={flow.name}>{capital(flow.trigger)}</PanelHeading>
      <PanelSection>
        <KeyValue label={side.area} value={world().people.areaLabel[flow.area]} />
        <KeyValue label={side.volume} value={f.volume(thousands(flow.perMonth))} />
        <KeyValue label={side.version} value={String(flow.version)} />
      </PanelSection>
      <PanelSection label={side.programs}>
        <div className="flex flex-wrap gap-1.5">{flow.programs.map((p) => <ActorBadge key={p} actor={{ kind: 'program', name: p }} />)}</div>
      </PanelSection>
      <PanelSection label={side.agents}>
        <ul className="space-y-2">
          {flowAgents(flow).map((id) => {
            const agent = agentById(id);
            return (
              <li key={id}>
                <ActorBadge actor={{ kind: 'agent', name: agent?.name ?? id }} />
                {agent && <p className="mt-0.5 text-compact leading-5 text-app-text-secondary">{capital(agent.does)}</p>}
              </li>
            );
          })}
        </ul>
      </PanelSection>
      <PanelSection label={side.stages(flow.name)}>
        <ul>
          {world().stages.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => openDaFare(ctx, { view: 'kanban', flow: flow.id, stage: s.id })}
                data-tip={`${side.stagesOpen} · ${s.label}`}
                className={clsx('-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1 text-left text-prose hover:bg-app-hover', FOCUS_RING)}
              >
                <span className="min-w-0 flex-1 text-app-text">{s.label}</span>
                <span className="tabular-nums font-semibold text-app-text">{summary.counts[s.id]}</span>
              </button>
            </li>
          ))}
        </ul>
        {/* A sentence, not a label and a value: the value wrapped in two right-aligned lines beside its label. */}
        <p className="mt-1.5 text-compact leading-5 text-app-text-secondary">
          {summary.share.agent + summary.share.person ? side.closedBy(summary.share.agent, summary.share.person) : side.noneClosed}
        </p>
      </PanelSection>
      <PanelSection label={side.lastTest}>
        {!last ? (
          <p className="text-compact leading-5 text-app-text-tertiary">{side.noTest}</p>
        ) : (
          <div data-try={flow.id}>
            <p className="text-prose font-semibold text-app-text">{test.result(last.cases.length, last.cases.length - look, look)}</p>
            <p className="text-compact text-app-text-tertiary">{test.at(momentLabel(last.at, ctx.now, ctx.copy), byName)}</p>
            {last.fallback && <p className="mt-1 text-compact text-app-text-secondary">{test.fallback(last.cases.length)}</p>}
            <ul className="mt-2 space-y-1">
              {last.cases.map((c) => {
                const card = cards.find((x) => x.id === c.card);
                return (
                  <li key={c.card}>
                    <button
                      type="button"
                      onClick={() => card && ctx.go(SP.card(card.id))}
                      className={clsx('-mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-app-hover', FOCUS_RING)}
                    >
                      <span className="shrink-0 text-prose font-semibold tabular-nums text-primary dark:text-primary-dark">{c.card}</span>
                      <span className="min-w-0 flex-1 text-compact leading-5 text-app-text-secondary">
                        {c.low.length ? c.low.map((v) => test.low(v.label, v.confidence)).join(' · ') : card?.title}
                      </span>
                      <Chip tone={c.low.length ? 'amber' : 'green'}>{c.low.length ? test.look : test.same}</Chip>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 flex items-start gap-1.5 text-compact leading-5 text-app-text-tertiary">
              <Bot size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
              {test.copyNote}
            </p>
          </div>
        )}
      </PanelSection>
    </SidePanel>
  );
}

export function FlowPlace({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const f = ctx.copy.sarimWork.flows;
  const flow = opsFlowById(id);
  const [, setFlows] = ctx.slice<FlowsSlice>(FLOWS_SLICE, FLOWS_INITIAL);
  if (!flow) return noFlow(ctx);

  const cards = liveCards(ctx.state);
  const paused = flowsSlice(ctx.state).paused[flow.id];
  const persona = personaById(ctx.persona.id);
  const job = ctx.job(tryJobId(flow.id));
  const running = job?.status === 'running';

  /** The cards of a step as small links, with the way to the rest in the list of cards. */
  const cardsOf = (here: SarimCard[], stage: string): ReactNode => {
    if (here.length === 0) return undefined;
    const shown = here.slice(0, CARDS_PER_STEP).map((c) => cardLink(c, ctx));
    return (
      <>
        {shown.map((c) => <CardLink key={c.id} card={c} />)}
        {here.length > CARDS_PER_STEP && (
          <button
            type="button"
            onClick={() => openDaFare(ctx, { view: 'kanban', flow: flow.id, stage })}
            className={clsx('h-6 rounded-md px-1.5 text-mini text-primary hover:underline dark:text-primary-dark', FOCUS_RING)}
          >
            {f.more(here.length - CARDS_PER_STEP)}
          </button>
        )}
      </>
    );
  };
  const split = splitOf(flow.id);
  const stageOfStep = (stepId: string) => flow.steps.find((x) => x.id === stepId)?.stage ?? '';
  /* A card at the split step stands in its lane, on the lane step it is at (the first one when the lane does not say). */
  const atSplit = split ? cardsAtStep(cards, flow, split.step) : [];
  const inLane = (laneId: string) => atSplit.filter((c) => c.lane === laneId);
  const model = opsCanvas(flow, ctx.copy, {
    triggerNote: f.volume(thousands(flow.perMonth)),
    step: (s) => ({ cards: cardsOf(cardsAtStep(cards, flow, s.id), s.stage) }),
    laneStep: (lane, _step, index) => {
      const at = lane.steps?.findIndex((x) => x.id === lane.at) ?? -1;
      return split && index === Math.max(at, 0) ? { cards: cardsOf(inLane(lane.id), stageOfStep(split.step)) } : {};
    },
  });
  const nodes: CanvasNode[] = model.nodes.map((n) => {
    if (n.kind !== 'split' || !split) return n;
    const claimed = new Set(n.lanes.map((l) => l.id));
    const loose = atSplit.filter((c) => !c.lane || !claimed.has(c.lane));
    return { ...n, cards: cardsOf(loose, stageOfStep(split.step)) };
  });
  const canvas = { ...model, nodes };
  /* A step of a lane opens the page of the step the flow splits at: the lanes have no page of their own. */
  const openStep = (stepId: string, laneId?: string) => ctx.go(SP.flowStep(flow.id, laneId && split ? split.step : stepId));

  const togglePause = () => {
    if (paused) {
      setFlows((prev) => ({ ...FLOWS_INITIAL, ...prev, paused: Object.fromEntries(Object.entries({ ...prev.paused }).filter(([k]) => k !== flow.id)) }));
      ctx.log(f.resumedLog(flow.name), 'structure', SP.flow(flow.id));
      ctx.toast({ tone: 'ok', title: f.resumedToast(flow.name) });
      return;
    }
    ctx.confirm({
      title: f.pauseConfirm.title(flow.name),
      body: f.pauseConfirm.body,
      confirmLabel: f.pauseConfirm.label,
      tone: 'danger',
      onConfirm: () => {
        setFlows((prev) => ({ ...FLOWS_INITIAL, ...prev, paused: { ...prev.paused, [flow.id]: { at: ctx.now, by: ctx.persona.id } } }));
        ctx.log(f.pausedLog(flow.name), 'structure', SP.flow(flow.id));
        ctx.toast({ tone: 'warn', title: f.pausedToast(flow.name), body: f.pauseConfirm.body });
        const people = [...new Set(flow.steps.flatMap((s) => (s.actor.kind === 'person' ? [s.actor.id] : [])))];
        ctx.notify({ title: f.pausedNotify(flow.name), body: f.pausedNotifyBody(persona?.short ?? ctx.persona.name), path: SP.flow(flow.id), tone: 'warn', to: [...new Set([...people, ctx.persona.id])] });
      },
    });
  };

  const runTry = () => {
    const today = ctx.now.slice(0, 10);
    const { day, fallback, cases } = yesterdayCases(cards, flow.id, today);
    ctx.startJob({
      id: tryJobId(flow.id),
      title: f.test.title(flow.name),
      steps: f.test.steps(dayLabel(day, today), cases.length, fallback).map((label) => ({ label, ms: 650 })),
      onDone: (ok) => {
        if (!ok) return;
        const result = { at: ctx.now, by: ctx.persona.id, day, fallback, cases: cases.map(tryCase) };
        const look = result.cases.filter((c) => c.low.length).length;
        setFlows((prev) => ({ ...FLOWS_INITIAL, ...prev, tries: { ...prev.tries, [flow.id]: result } }));
        ctx.log(f.test.log(flow.name, cases.length, look), 'test', SP.flow(flow.id));
        ctx.toast({ tone: look ? 'warn' : 'ok', title: f.test.done(flow.name), body: f.test.result(cases.length, cases.length - look, look) });
      },
    });
  };

  return (
    <OpsFlowScreen
      name={flow.name}
      outcome={flow.outcome}
      status={flowStatus(flow, Boolean(paused), ctx)}
      version={flow.version}
      onBack={() => ctx.go(SP.flows())}
      controls={{
        onOpenInDaFare: () => openDaFare(ctx, { view: 'list', flow: flow.id }),
        onTry: running ? false : ctx.allow('run:tests', runTry),
        tryTitle: running ? f.test.running : ctx.deniedTitle('run:tests') ?? f.tryTitle,
        onPause: ctx.allow('edit:structure', togglePause),
        pauseTitle: ctx.deniedTitle('edit:structure'),
        paused: Boolean(paused),
      }}
      banner={paused ? f.pausedBanner(personaById(paused.by)?.short ?? paused.by, momentLabel(paused.at, ctx.now, ctx.copy)) : undefined}
      job={running && job ? { label: f.test.running, detail: job.current, value: job.progress } : undefined}
      canvas={canvas}
      onStep={openStep}
      side={<SideRows flow={flow} ctx={ctx} />}
      copy={ctx.copy}
      phone={ctx.phone}
      crumbs={orgCrumbs(ctx, [{ label: f.title, to: SP.flows() }, { label: flow.name }])}
    />
  );
}
