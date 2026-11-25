/**
 * The page of one card of «Da fare» (allow-italian: quotes the Italian interface) in the ORBIT edition,
 * and one of its originals opened large. On a desktop the cards of the flow
 * stay in view on the left, folded into one column; on a phone the card fills
 * the screen. Every action goes through `actions.ts`, so a card taken, moved,
 * sent back or approved here is the same card on the kanban, in the stage view
 * and in the sidebar count.
 */
import { Check, CirclePause, CornerUpLeft, FileSearch, FileSignature, Hand, MoveRight, Scale, Signature, SquareKanban } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { BoardStrip, type StripGroupModel } from '../../../../ui/kanban/BoardStrip';
import { CardDetail, type CardActionModel, type CardEventModel, type CardSection, type CardValueModel } from '../../../../ui/kanban/CardDetail';
import { FlowPanel } from '../../../../ui/kanban/FlowReadonly';
import { canvasSteps } from '../../../../ui/flows/canvasOf';
import type { CanvasLane, CanvasOriginal, CanvasStep, CanvasStepState, FlowCanvasModel } from '../../../../ui/flows/model';
import { ORIGINAL_ICON } from '../../../../ui/kanban/glyphs';
import { WorkerBadge } from '../../../../ui/kanban/parts';
import { OriginalPage } from '../../../../ui/kanban/OriginalPage';
import type { OriginalModel, QuoteMarkModel } from '../../../../ui/kanban/model';
import type { CardOriginal, OpsFlow, OrbitCard } from '../../../../ui/fixtures/orbit-org/types';
import { daysFromToday, formatShortDay } from '../../../../ui/fixtures/org/clock';
import { personaById, world } from '../../world';
import type { Params, ScreenCtx } from '../../../app/kit';
import { cardMoments, kanbanSlice, liveCardById, liveContractById, stageOf } from '../../model/live';
import { flowLevel } from '../../model/access';
import { clauseIn, currentVersion } from '../../model/contracts';
import { hoursBetween, formatHours, isStuck, scopeCards } from '../../model/stages';
import { flowLabel } from '../../model/flows';
import { openDaFare } from '../../model/dafare';
import { opsCanvas, splitOf } from '../../model/canvas';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { approveCard, correctValue, isCorrected, moveCard, sendBackCard, takeCard } from './actions';
import { CardChat } from './card-chat';
import { CloseOnEscape } from './close-on-escape';
import {
  APPROVAL, CHECK, CONTRACTS_FLOW, DONE, STAGE_GLYPH_OF, ageOf, canClose, isFresh, columnOrder, dueTag, flowRef,
  flowIcon, moveCheck, moveOptions, nextStage, priorityTag, stageLabel, stamp, stepAt, stepLine, stopInfo, visibleCards, whoName, workDenied, workerModel,
} from './model';

const valueKey = (id: string) => `orbit.card.${id}.value`;

/** Which folds of the card page the person closed; kept for every card, so a closed fold stays closed on the next one. */
const SECTIONS_KEY = 'orbit.card.sections';

/** The step of the flow whose detail is open beside the card; kept for every card. */
const flowStepKey = (id: string) => `orbit.card.${id}.flowStep`;

/**
 * An original as the card page and the large page draw it: «Fattura · SDI · 06/11 09:12». (allow-italian: quotes the Italian interface)
 * When the source already starts with the kind («mail AMA») the source is the (allow-italian: quotes the Italian interface)
 * label, so the line never reads «Mail · mail AMA». (allow-italian: quotes the Italian interface)
 */
function originalModel(o: CardOriginal, ctx: ScreenCtx): OriginalModel {
  const kind = ctx.copy.kanban.original.kinds[o.kind];
  const repeats = o.from.toLowerCase().startsWith(`${kind.toLowerCase()} `);
  const label = repeats ? `${o.from.charAt(0).toUpperCase()}${o.from.slice(1)}` : kind;
  return { id: o.id, name: o.name, kind: o.kind, kindLabel: label, from: repeats ? stamp(o.at) : `${o.from} · ${stamp(o.at)}`, lines: o.lines, image: o.image };
}

function marksOf(card: OrbitCard, doc: string): QuoteMarkModel[] {
  return card.values.filter((v) => v.doc === doc).map((v) => ({ id: v.label, quote: v.quote, label: `${v.label}: ${v.value}` }));
}

/** The card the address names, unless its flow is hidden from the person: then it is as if it were not there. */
function cardFor(id: string, ctx: ScreenCtx): OrbitCard | undefined {
  const card = liveCardById(ctx.state, id);
  return card && flowLevel(ctx.state, ctx.persona, card.flow) !== 'none' ? card : undefined;
}

/** The card the address names, or the page that says it is not there. */
function missing(ctx: ScreenCtx, title: string, body: string) {
  return (
    <EmptyState icon={FileSearch} title={title} action={<Button onClick={() => ctx.go(SP.inbox())}>{ctx.copy.kanban.detail.back}</Button>}>
      {body}
    </EmptyState>
  );
}

/**
 * The history of the card, oldest first: each column it entered with who moved
 * it and how long it stayed, a hand taken without a move, then the places it
 * leads (its contract, the clause, the signatures, another card) as the last
 * rows, so nothing about the card is told in a block of its own.
 */
function eventsOf(card: OrbitCard, ctx: ScreenCtx): CardEventModel[] {
  const d = ctx.copy.kanban.detail;
  const dated: Array<CardEventModel & { sort: string }> = card.history.map((e, i) => {
    const current = i === card.history.length - 1;
    const end = card.history[i + 1]?.at ?? ctx.now;
    const time = formatHours(hoursBetween(e.at, end));
    return {
      id: `stage-${i}`,
      sort: e.at,
      title: stageLabel(e.stage),
      glyph: STAGE_GLYPH_OF[e.stage],
      at: stamp(e.at),
      who: i === 0 ? d.arrivedBy(whoName(e.by).short) : d.movedBy(whoName(e.by).short),
      detail: e.stage === DONE ? '' : current ? (isFresh(e.at, end) ? d.justEntered : d.stillThere(time)) : d.stayed(time),
      current,
    };
  });
  /* What the head of the card tells and the column entries do not (who took it, the stop and why): same story in both places. */
  cardMoments(card).forEach((m, i) => {
    if (m.kind === 'took') dated.push({ id: `took-${i}`, sort: m.at, title: d.tookOver(whoName(m.by).short), icon: Hand, at: stamp(m.at), detail: m.text });
    else dated.push({ id: `stopped-${i}`, sort: m.at, title: d.stopped, icon: CirclePause, at: stamp(m.at), detail: m.text });
  });
  const taken = kanbanSlice(ctx.state).workers[card.id];
  if (taken && !card.history.some((e) => e.at === taken.since) && taken.since !== card.worker.since) {
    const by = taken.kind === 'agent' ? `agent:${taken.id}` : taken.id;
    dated.push({ id: 'hand', sort: taken.since, title: d.tookOver(whoName(by).short), icon: Hand, at: stamp(taken.since), detail: taken.doing });
  }
  dated.sort((x, y) => x.sort.localeCompare(y.sort));
  const out: CardEventModel[] = dated.map(({ sort: _sort, ...e }) => e);
  const contractId = card.links?.contract;
  const contract = contractId ? liveContractById(ctx.state, contractId) : undefined;
  if (contractId && contract) {
    out.push({ id: 'contract', title: contract.title, detail: d.contract, icon: FileSignature, at: '', onOpen: () => ctx.go(SP.contract(contractId)) });
    const clauseId = card.links?.clause;
    const clause = clauseId ? clauseIn(currentVersion(contract), clauseId) : undefined;
    if (clauseId && clause) out.push({ id: 'clause', title: d.clause(clause.n), detail: clause.title, icon: Scale, at: '', onOpen: () => ctx.go(SP.clause(contractId, clauseId)) });
    if (card.flow === CONTRACTS_FLOW) out.push({ id: 'signatures', title: d.signatures, icon: Signature, at: '', onOpen: () => ctx.go(SP.signatures(contractId)) });
  }
  const linked = card.links?.card ? liveCardById(ctx.state, card.links.card) : undefined;
  if (linked) out.push({ id: 'card', title: d.linkedCard(linked.id), detail: linked.title, icon: SquareKanban, at: '', onOpen: () => ctx.go(SP.card(linked.id)) });
  return out;
}

/**
 * The history entry a step of the flow corresponds to: the one where the card
 * entered the step's column (the last time, when it went back and forth). A
 * column the card skipped (moved by hand) falls back to the first entry.
 */
function entryFor(card: OrbitCard, stage: string) {
  return [...card.history].reverse().find((e) => e.stage === stage) ?? card.history[0];
}

/**
 * The step an original belongs to. Each step started when the card entered its
 * column; the original belongs to the last step reached that had started by
 * the time the original came in (the first step when it came in before them
 * all). A mail sent while the card stands at a later step is that step's.
 */
function originalStepIndex(card: OrbitCard, flow: OpsFlow, reached: number, original: CardOriginal): number {
  let found = 0;
  for (let i = 0; i <= reached; i++) {
    if (entryFor(card, flow.steps[i].stage).at <= original.at) found = i;
  }
  return found;
}

/**
 * The flow of the card to read, as the one drawing of a flow shows it
 * (`opsCanvas`): the steps before the card's are done (who and when come from
 * the history), the card's step is marked with who has it now, the ones after
 * come next. Where the flow splits by case, the lane the card takes is the
 * taken one and the card stands on its step; the other lanes carry no state
 * (the drawing sets them quieter). Each original sits on the step it belongs
 * to.
 */
function flowModel(card: OrbitCard, ctx: ScreenCtx): FlowCanvasModel | undefined {
  const at = stepAt(card);
  const flow = at.flow;
  if (!flow) return undefined;
  const d = ctx.copy.kanban.detail.flowPanel;
  const split = splitOf(flow.id);
  const splitIndex = split ? flow.steps.findIndex((s) => s.id === split.step) : -1;
  const reached = at.index < 0 ? 0 : at.index;
  const atSplit = splitIndex >= 0 && at.index === splitIndex;
  const pastSplit = splitIndex >= 0 && at.index > splitIndex;
  const doneBy = (stage: string) => {
    const entry = entryFor(card, stage);
    return d.doneBy(whoName(entry.by).short, entry.at.slice(8, 10) + '/' + entry.at.slice(5, 7), entry.at.slice(11, 16));
  };
  const originalsAt = (index: number): CanvasOriginal[] => card.originals.filter((o) => originalStepIndex(card, flow, reached, o) === index).map((o) => {
    const m = originalModel(o, ctx);
    return { id: o.id, name: o.name, icon: ORIGINAL_ICON[o.kind], meta: `${m.kindLabel} · ${m.from}`, onOpen: () => ctx.go(SP.cardOriginal(card.id, o.id)) };
  });
  const here = { flag: d.here, here: <WorkerBadge worker={workerModel(card, ctx)} /> };
  return opsCanvas(flow, ctx.copy, {
    reached: atSplit || pastSplit,
    step: (s, i): Partial<CanvasStep> => {
      const state: CanvasStepState = at.index < 0 || i > at.index ? 'next' : i === at.index ? 'current' : 'done';
      return {
        state,
        done: state === 'done' ? doneBy(s.stage) : undefined,
        ...(state === 'current' ? here : {}),
        originals: originalsAt(i),
      };
    },
    lane: (l): Partial<CanvasLane> => ({ taken: (atSplit || pastSplit) && l.id === card.lane }),
    laneStep: (l, _step, j): Partial<CanvasStep> => {
      if (!split || l.id !== card.lane || !(atSplit || pastSplit)) return {};
      const steps = l.steps ?? [];
      const last = j === steps.length - 1;
      const first = j === 0 ? { originals: originalsAt(splitIndex) } : {};
      if (pastSplit) return { ...first, state: 'done', done: last ? doneBy(flow.steps[splitIndex].stage) : undefined };
      const standing = Math.max(0, steps.findIndex((x) => x.id === l.at));
      if (j < standing) return { ...first, state: 'done' };
      return j === standing ? { ...first, state: 'current', ...here } : { ...first, state: 'next' };
    },
  });
}

/** The buttons of the next action: forward or approve first, then take it, send it back. Off ones say why in their tip; a closed card has none. */
function actionsOf(card: OrbitCard, ctx: ScreenCtx): CardActionModel[] {
  const a = ctx.copy.kanban.actions;
  const stage = stageOf(card);
  if (stage === DONE) return [];
  const editDenied = workDenied(card.flow, ctx);
  const out: CardActionModel[] = [];
  if (stage === APPROVAL) {
    const contract = card.flow === CONTRACTS_FLOW && Boolean(card.links?.contract);
    const allowed = !editDenied && (contract || canClose(card, ctx));
    out.push({
      id: 'approve',
      label: contract ? a.approveInContract : a.approve,
      variant: 'confirm',
      icon: Check,
      onClick: allowed ? () => approveCard(ctx, card) : false,
      title: editDenied ?? (contract ? a.approveInContractHint : allowed ? a.approveHint : a.closeNeeds(whoName(card.reviewer).short)),
    });
  } else {
    const next = nextStage(stage);
    if (next) {
      const check = moveCheck(card, next, ctx);
      const waits = check.kind !== 'denied' && Boolean(card.blocked);
      out.push({
        id: 'forward',
        label: stage === CHECK ? a.forward : a.forwardTo(stageLabel(next)),
        variant: 'primary',
        icon: MoveRight,
        onClick: check.kind === 'denied' || waits ? false : () => moveCard(ctx, card, next),
        title: check.kind === 'denied' ? check.reason : waits ? a.forwardWaits : a.forwardHint(stageLabel(next)),
      });
    }
  }
  const mine = card.worker.kind === 'person' && card.worker.id === ctx.persona.id;
  const takeWhy = editDenied ?? (mine ? a.takeMine : undefined);
  out.push({ id: 'take', label: a.take, variant: 'secondary', icon: Hand, onClick: takeWhy ? false : () => takeCard(ctx, card), title: takeWhy });
  const backWhy = editDenied ?? (card.worker.kind === 'agent' ? a.sendBackAgent(whoName(`agent:${card.worker.id}`).short) : undefined);
  out.push({ id: 'back', label: a.sendBack, variant: 'ghost', icon: CornerUpLeft, onClick: backWhy ? false : () => sendBackCard(ctx, card), title: backWhy });
  return out;
}

function stripGroups(cards: OrbitCard[], current: string, ctx: ScreenCtx): StripGroupModel[] {
  const order = columnOrder(ctx.now);
  return world().stages.map((s) => ({
    id: s.id,
    label: s.label,
    glyph: STAGE_GLYPH_OF[s.id],
    cards: cards.filter((c) => stageOf(c) === s.id).sort(order).map((c) => ({
      id: c.id,
      title: c.title,
      who: whoName(c.worker.kind === 'agent' ? `agent:${c.worker.id}` : c.worker.id).short,
      flag: stageOf(c) === DONE ? undefined : c.blocked ? 'red' as const : isStuck(c, world().opsFlows, ctx.now) ? 'amber' as const : undefined,
      current: c.id === current,
    })),
  }));
}

/** The due day with how far it is, in the tone of its urgency; none on a closed card or one with no due day. */
function dueOf(card: OrbitCard, ctx: ScreenCtx) {
  const tag = dueTag(card, ctx.copy);
  if (!tag || !card.due) return undefined;
  return { text: ctx.copy.kanban.detail.dueDay(formatShortDay(card.due), daysFromToday(card.due)), tone: tag.tone, title: tag.title };
}

export function cardTitle(params: Params, ctx: ScreenCtx): string {
  const card = cardFor(params.card ?? '', ctx);
  return card ? `${card.id} ${card.title}` : ctx.copy.kanban.detail.notFound;
}

export function renderCard(params: Params, ctx: ScreenCtx, opts: { flow?: boolean } = {}) {
  const k = ctx.copy.kanban;
  const d = k.detail;
  const card = cardFor(params.card ?? '', ctx);
  if (!card) return missing(ctx, d.notFound, d.notFoundBody(params.card ?? ''));

  const stage = stageOf(card);
  const [activeValue, setActiveValue] = ctx.ui<string>(valueKey(card.id), '');
  const [flowStep, setFlowStep] = ctx.ui<string>(flowStepKey(card.id), '');
  const [folded, setFolded] = ctx.ui<Partial<Record<CardSection, boolean>>>(SECTIONS_KEY, {});
  const stop = stopInfo(card, ctx);
  const step = stepAt(card);
  const reviewer = personaById(card.reviewer);
  const edit = workDenied(card.flow, ctx) === undefined;
  const values: CardValueModel[] = card.values.map((v) => ({
    id: v.label, label: v.label, value: v.value, confidence: v.confidence, corrected: isCorrected(ctx, card.id, v.label), doc: v.doc,
  }));
  const confidence = card.values.length ? Math.min(...card.values.map((v) => v.confidence)) : 100;
  const high = priorityTag(card, ctx.copy);
  const pickValue = (label: string) => {
    const next = activeValue === label ? '' : label;
    setActiveValue(next);
  };
  const back = SP.inbox();
  const strip = scopeCards(visibleCards(ctx.state, ctx.persona), card.flow);
  const flowOpen = Boolean(opts.flow);
  const flow = flowOpen ? flowModel(card, ctx) : undefined;
  const flowSelected = flow ? canvasSteps(flow).find((x) => x.id === flowStep) : undefined;
  const flowCrumbs = flowOpen
    ? [{ label: card.id, to: SP.card(card.id) }, { label: d.openFlow }]
    : [{ label: card.id }];
  return (
    <div data-worker={card.worker.kind} data-card-page={card.id} className="relative flex h-full min-h-0 min-w-0">
      {/* With the flow open the column of cards gives its room to the card and the flow. */}
      {!ctx.phone && !flowOpen && (
        <BoardStrip
          title={k.titleIn(flowLabel(card.flow))}
          backLabel={d.back}
          groups={stripGroups(strip, card.id, ctx)}
          onBack={() => ctx.go(back)}
          onOpen={(id) => ctx.go(SP.card(id))}
          openLabel={k.card.open}
        />
      )}
      <CardDetail
        back={{ label: k.title, onClick: () => ctx.go(back) }}
        crumbs={orgCrumbs(ctx, [{ label: k.title, to: SP.inbox() }, { label: flowLabel(card.flow), onSelect: () => openDaFare(ctx, { flow: card.flow }) }, ...flowCrumbs])}
        move={{
          items: moveOptions(card, ctx),
          disabledTitle: workDenied(card.flow, ctx),
          onMove: (to) => moveCard(ctx, card, to as typeof stage),
        }}
        head={{
          title: card.title,
          detail: card.detail,
          flow: flowRef(card),
          step: step.step && step.index >= 0 ? d.stepPosition(step.index + 1, step.total, stepLine(step.step.title)) : '',
          stage: { label: stageLabel(stage), glyph: STAGE_GLYPH_OF[stage] },
        }}
        flow={{ open: flowOpen, onToggle: () => ctx.go(flowOpen ? SP.card(card.id) : SP.cardFlow(card.id)) }}
        worker={workerModel(card, ctx)}
        workerTip={isFresh(card.worker.since, ctx.now) ? d.justNowAt(stamp(card.worker.since)) : d.sinceAt(ageOf(card.worker.since, ctx.now), stamp(card.worker.since))}
        reviewer={{ same: card.worker.kind === 'person' && card.worker.id === card.reviewer, name: reviewer?.short ?? card.reviewer, monogram: reviewer?.monogram ?? '', color: reviewer?.color ?? '#64748b' }}
        due={dueOf(card, ctx)}
        priority={high && high.tone === 'red' ? { ...high, text: high.title ?? high.text } : undefined}
        stopped={stop.blocked ? { text: stop.blocked.text, reason: stop.blocked.reason, tone: 'red' } : stop.stuck ? { text: stop.stuck.text, reason: stop.stuck.title ?? '', tone: 'amber' } : undefined}
        next={{ text: card.proposal, confidence, closed: stage === DONE }}
        actions={actionsOf(card, ctx)}
        values={values}
        activeValue={activeValue || undefined}
        onValue={pickValue}
        onEditValue={edit ? (label, value) => correctValue(ctx, card, label, value) : undefined}
        originals={card.originals.map((o) => ({ original: originalModel(o, ctx), marks: marksOf(card, o.id) }))}
        onOpenOriginal={(id) => ctx.go(SP.cardOriginal(card.id, id))}
        history={eventsOf(card, ctx)}
        chat={<CardChat card={card} ctx={ctx} />}
        sections={{
          open: { original: folded.original !== false, history: folded.history !== false, chat: folded.chat !== false },
          onToggle: (id) => setFolded((prev) => ({ ...prev, [id]: prev[id] === false })),
        }}
        copy={ctx.copy}
        phone={ctx.phone}
        narrow={flowOpen}
      />
      {flow && (
        <>
          <FlowPanel
            name={flowLabel(card.flow)}
            icon={flowIcon(card.flow)}
            model={flow}
            onOpenFull={() => ctx.go(SP.flow(card.flow))}
            selected={flowSelected}
            onStep={(id) => setFlowStep(flowStep === id ? '' : id)}
            onCloseStep={() => setFlowStep('')}
            copy={ctx.copy}
            onClose={() => ctx.go(SP.card(card.id))}
            phone={ctx.phone}
          />
          <CloseOnEscape onClose={() => ctx.go(SP.card(card.id))} />
        </>
      )}
    </div>
  );
}

export function originalTitle(params: Params, ctx: ScreenCtx): string {
  const card = cardFor(params.card ?? '', ctx);
  return card?.originals.find((o) => o.id === params.doc)?.name ?? ctx.copy.kanban.original.notFound;
}

export function renderOriginal(params: Params, ctx: ScreenCtx) {
  const k = ctx.copy.kanban;
  const card = cardFor(params.card ?? '', ctx);
  if (!card) return missing(ctx, k.detail.notFound, k.detail.notFoundBody(params.card ?? ''));
  const original = card.originals.find((o) => o.id === params.doc);
  if (!original) return missing(ctx, k.original.notFound, k.original.notFoundBody(params.doc ?? '', card.id));
  const [activeValue, setActiveValue] = ctx.ui<string>(valueKey(card.id), '');
  const here = card.values.filter((v) => v.doc === original.id);
  const active = here.some((v) => v.label === activeValue) ? activeValue : undefined;
  return (
    <div data-worker={card.worker.kind} data-original={original.id} className="flex h-full min-h-0 min-w-0 flex-col">
      <OriginalPage
        back={{ label: card.id, onClick: () => ctx.go(SP.card(card.id)) }}
        crumbs={orgCrumbs(ctx, [{ label: k.title, to: SP.inbox() }, { label: flowLabel(card.flow), onSelect: () => openDaFare(ctx, { flow: card.flow }) }, { label: card.id, to: SP.card(card.id) }, { label: original.name }])}
        original={originalModel(original, ctx)}
        marks={marksOf(card, original.id)}
        active={active}
        onMark={(id) => setActiveValue((prev) => (prev === id ? '' : id))}
        values={here.map((v) => ({ id: v.label, label: v.label, value: v.value, confidence: v.confidence, corrected: isCorrected(ctx, card.id, v.label) }))}
        others={card.originals.map((o) => ({ id: o.id, name: o.name, kind: o.kind, current: o.id === original.id }))}
        onOther={(id) => ctx.go(SP.cardOriginal(card.id, id))}
        copy={ctx.copy}
        phone={ctx.phone}
      />
    </div>
  );
}
