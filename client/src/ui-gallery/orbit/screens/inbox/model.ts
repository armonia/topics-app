/**
 * From the live cards of ORBIT to what the kanban, the list, the stage view
 * and the card page draw: who has a card and since when, the step of the flow
 * it is at in words, its dates and states, the columns it may move to and why
 * not. Every number comes from `model/live.ts` and `model/stages.ts`, so the
 * kanban, the stage view and the sidebar count the same cards.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { Tone } from '../../../../ui/types';
import type { CardRowModel, FlowRefModel, KanbanCardModel, MoveOptionModel, StageGlyph, TagModel, WorkerModel } from '../../../../ui/kanban/model';
import type { OpsFlow, OpsFlowStep, OrbitCard, StageId } from '../../../../ui/fixtures/orbit-org/types';
import { agentById, personaById, world } from '../../world';
import { daysFromToday, formatDay, formatShortDay } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../../app/kit';
import type { DemoState } from '../../../app/store/state';
import type { Persona } from '../../../../ui/fixtures/org/people';
import { liveCards, stageOf, stageSince } from '../../model/live';
import { formatHours, hoursBetween, isStuck } from '../../model/stages';
import { flowLabel, opsFlowById } from '../../model/flows';
import { atLeast, flowLevel, sectionLevel } from '../../model/access';
import { flowIcon } from '../../model/flows';

/* ---------- the stages and flows by name ---------- */

export const INCOMING: StageId = 'arrivo'; // allow-italian: stage id, compared by value
export const WORKING: StageId = 'lavorazione'; // allow-italian: stage id, compared by value
export const CHECK: StageId = 'verifica'; // allow-italian: stage id, compared by value
export const APPROVAL: StageId = 'approvazione'; // allow-italian: stage id, compared by value
export const DONE: StageId = 'fatto'; // allow-italian: stage id, compared by value
/** The flow whose approvals happen in the contract, not on the kanban. */
export const CONTRACTS_FLOW = world().flowRoles.variants;

export const STAGE_IDS: StageId[] = world().stages.map((s) => s.id);

export const STAGE_GLYPH_OF: Record<StageId, StageGlyph> = {
  arrivo: 'incoming',
  lavorazione: 'working',
  verifica: 'check',
  approvazione: 'approve',
  fatto: 'done',
};

export { flowIcon };

export function stageLabel(id: StageId): string {
  return world().stages.find((s) => s.id === id)?.label ?? id;
}

export const isOpen = (card: OrbitCard) => stageOf(card) !== DONE;

/* ---------- times and people ---------- */

/** `06/11 09:40` of a time written in Rome time (`2026-11-06T09:40:00+01:00`). */
export function stamp(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

/** How long from `since` to now, the short way: `12 min`, `3 h 10`, `2 g`. */
export function ageOf(since: string, now: string): string {
  return formatHours(hoursBetween(since, now));
}

/** A person or an agent by the id a history entry or a worker carries (`agent:<id>` or a persona id). */
export function whoName(by: string): { short: string; full: string } {
  if (by.startsWith('agent:')) {
    const a = agentById(by.slice(6));
    return { short: a?.name ?? by, full: a?.name ?? by };
  }
  const p = personaById(by);
  return { short: p?.short ?? by, full: p?.name ?? by };
}

/** Under a minute: «adesso» rather than «da 0 min». (allow-italian: quotes the Italian interface) */
export function isFresh(since: string, now: string): boolean {
  return hoursBetween(since, now) < 1 / 60;
}

export function workerModel(card: OrbitCard, ctx: ScreenCtx): WorkerModel {
  const w = card.worker;
  const c = ctx.copy.kanban.card;
  const since = isFresh(w.since, ctx.now) ? c.justNow : c.since(ageOf(w.since, ctx.now));
  if (w.kind === 'agent') {
    const a = agentById(w.id);
    return { kind: 'agent', name: a?.name ?? w.id, fullName: a?.name ?? w.id, doing: w.doing, since, active: isOpen(card) };
  }
  const p = personaById(w.id);
  return { kind: 'person', name: p?.short ?? w.id, fullName: p?.name ?? w.id, monogram: p?.monogram, color: p?.color, doing: w.doing, since };
}

/* ---------- the flow ---------- */

export interface StepAt {
  flow?: OpsFlow;
  step?: OpsFlowStep;
  /** 0-based, -1 when the flow has no step for the card's column. */
  index: number;
  total: number;
}

/**
 * The step a card is at: its own step while it stands in that step's column;
 * after a move by hand, the first step of its flow in the column it went to.
 */
export function stepAt(card: OrbitCard): StepAt {
  const flow = world().opsFlows.find((f) => f.id === card.flow);
  if (!flow) return { index: -1, total: 0 };
  const stage = stageOf(card);
  const own = flow.steps.find((s) => s.id === card.step);
  const step = own && own.stage === stage ? own : flow.steps.find((s) => s.stage === stage) ?? own;
  return { flow, step, index: step ? flow.steps.indexOf(step) : -1, total: flow.steps.length };
}

/**
 * A step title as the line «Passo 1 di 7 · …» and the chat carry it: a title
 * written as «Legge la segnalazione: indirizzo, tipo» keeps its list in
 * brackets, so a line never holds two colons.
 */
export function stepLine(title: string): string {
  const at = title.indexOf(': ');
  return at < 0 ? title : `${title.slice(0, at)} (${title.slice(at + 2)})`;
}

export function nextStage(stage: StageId): StageId | undefined {
  return STAGE_IDS[STAGE_IDS.indexOf(stage) + 1];
}

/* ---------- dates and states ---------- */

/** Red when past or today, amber within three days, grey after; none on a closed card. */
export function dueTag(card: OrbitCard, copy: UiCopy): TagModel | undefined {
  if (!card.due || !isOpen(card)) return undefined;
  const c = copy.kanban.card;
  const days = daysFromToday(card.due);
  const day = formatShortDay(card.due);
  const text = days < 0 ? c.overdue(day) : days === 0 ? c.today : days === 1 ? c.tomorrow : day;
  const tone: Tone = days <= 0 ? 'red' : days <= 3 ? 'amber' : 'neutral';
  return { text, tone, title: c.due(formatDay(card.due)) };
}

export function priorityTag(card: OrbitCard, copy: UiCopy): TagModel | undefined {
  const c = copy.kanban.card;
  if (card.priority === 'alta') return { text: c.high, tone: 'red', title: c.priority(c.high) }; // allow-italian: priority value, compared by value
  if (card.priority === 'bassa') return { text: c.low, tone: 'neutral', title: c.priority(c.low) }; // allow-italian: priority value, compared by value
  return undefined;
}

export interface StopInfo {
  blocked?: { text: string; reason: string; title: string };
  stuck?: TagModel;
}

/** Why an open card is stopped: blocked on something outside it, or left in its column past its flow's limit. */
export function stopInfo(card: OrbitCard, ctx: ScreenCtx): StopInfo {
  if (!isOpen(card)) return {};
  const c = ctx.copy.kanban.card;
  if (card.blocked) return { blocked: { text: c.stuck(ageOf(card.blocked.since, ctx.now)), reason: card.blocked.reason, title: c.blockedTitle(card.blocked.reason, stamp(card.blocked.since)) } };
  if (!isStuck(card, world().opsFlows, ctx.now)) return {};
  const limit = formatHours(opsFlowById(card.flow)?.stuckAfterHours ?? 0);
  return { stuck: { text: c.stuck(ageOf(stageSince(card), ctx.now)), tone: 'amber', title: c.stuckTitle(stageLabel(stageOf(card)), limit) } };
}

/* ---------- who may see and move what ---------- */

/** The cards the person on show may see: a flow at level «none» hides its cards everywhere. */
export function visibleCards(state: DemoState, persona: Persona): OrbitCard[] {
  return liveCards(state).filter((c) => flowLevel(state, persona, c.flow) !== 'none');
}

/** The flows the person may see at all. */
export function visibleFlows(state: DemoState, persona: Persona): OpsFlow[] {
  return world().opsFlows.filter((f) => flowLevel(state, persona, f.id) !== 'none');
}

/** Why the person cannot work on the cards of a flow (move, take, send back, correct a value); undefined when they can. */
export function workDenied(flowId: string, ctx: ScreenCtx): string | undefined {
  const editing = ctx.deniedTitle('edit:data');
  if (editing) return editing;
  if (!atLeast(sectionLevel(ctx.state, ctx.persona, 'inbox'), 'work')) return ctx.copy.kanban.access.sectionView;
  if (!atLeast(flowLevel(ctx.state, ctx.persona, flowId), 'work')) return ctx.copy.kanban.access.flowView(flowLabel(flowId));
  return undefined;
}

const PRIORITY_RANK: Record<OrbitCard['priority'], number> = { alta: 0, normale: 1, bassa: 2 };

/**
 * The order inside a column: what is stopped first, then the high priority,
 * then the nearest due day, then the card that entered the column last. In
 * «Fatto» the last closed comes first. (allow-italian: quotes the Italian interface)
 */
export function columnOrder(now: string) {
  return (a: OrbitCard, b: OrbitCard): number => {
    if (stageOf(a) === DONE) return stageSince(b).localeCompare(stageSince(a));
    const stopA = isStuck(a, world().opsFlows, now) ? 0 : 1;
    const stopB = isStuck(b, world().opsFlows, now) ? 0 : 1;
    return stopA - stopB
      || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || (a.due ?? '9999').localeCompare(b.due ?? '9999')
      || stageSince(b).localeCompare(stageSince(a));
  };
}

/* ---------- who may move a card where ---------- */

export type MoveCheck = { kind: 'ok' } | { kind: 'denied'; reason: string } | { kind: 'contract'; contract: string };

/** The reviewer of the card, or anyone allowed to approve. */
export function canClose(card: OrbitCard, ctx: ScreenCtx): boolean {
  return ctx.persona.id === card.reviewer || ctx.can('approve');
}

/**
 * Whether the person on show may move the card to a column. Moving needs the
 * level «Lavora» on the card's flow; closing it in «Fatto» needs the reviewer or `approve`; a card (allow-italian: quotes the Italian interface)
 * of the contract variations flow is approved in its contract, so closing it leads
 * there instead.
 */
export function moveCheck(card: OrbitCard, to: StageId, ctx: ScreenCtx): MoveCheck {
  const why = workDenied(card.flow, ctx);
  if (why) return { kind: 'denied', reason: why };
  if (to !== DONE) return { kind: 'ok' };
  if (card.flow === CONTRACTS_FLOW && card.links?.contract) return { kind: 'contract', contract: card.links.contract };
  if (!canClose(card, ctx)) return { kind: 'denied', reason: ctx.copy.kanban.actions.closeNeeds(whoName(card.reviewer).short) };
  return { kind: 'ok' };
}

export function moveOptions(card: OrbitCard, ctx: ScreenCtx): MoveOptionModel[] {
  return STAGE_IDS.filter((s) => s !== stageOf(card)).map((s) => {
    const check = moveCheck(card, s, ctx);
    return {
      id: s,
      label: ctx.copy.kanban.board.moveItem(stageLabel(s)),
      disabled: check.kind === 'denied',
      title: check.kind === 'denied' ? check.reason : undefined,
    };
  });
}

/* ---------- view models ---------- */

export function flowRef(card: OrbitCard): FlowRefModel {
  return { label: flowLabel(card.flow), icon: flowIcon(card.flow), title: opsFlowById(card.flow)?.source };
}

export function kanbanCardModel(card: OrbitCard, ctx: ScreenCtx): KanbanCardModel {
  const stop = stopInfo(card, ctx);
  return {
    id: card.id,
    title: card.title,
    detail: card.detail,
    flow: flowRef(card),
    priority: priorityTag(card, ctx.copy),
    due: dueTag(card, ctx.copy),
    blocked: stop.blocked,
    stuck: stop.stuck,
    step: stepAt(card).step?.title ?? '',
    worker: workerModel(card, ctx),
    reviewer: ctx.copy.kanban.card.reviewer(whoName(card.reviewer).short),
    moveTo: moveOptions(card, ctx),
    moveDisabledTitle: workDenied(card.flow, ctx),
  };
}

/**
 * How long the card has stood in its column: red when blocked, amber past the
 * limit of its flow, quiet otherwise; nothing on a closed card. Always the time
 * in the column, so the table has one measure under one name: for a blocked
 * card the time since it was blocked is in the tooltip, not in the cell.
 */
export function inStageTag(card: OrbitCard, ctx: ScreenCtx): TagModel | undefined {
  if (!isOpen(card)) return undefined;
  const c = ctx.copy.kanban.card;
  const since = stageSince(card);
  const text = isFresh(since, ctx.now) ? c.justNow : ageOf(since, ctx.now);
  if (card.blocked) return { text, tone: 'red', title: c.blockedTitle(card.blocked.reason, stamp(card.blocked.since)) };
  if (!isStuck(card, world().opsFlows, ctx.now)) return { text, tone: 'neutral' };
  return { text, tone: 'amber', title: c.stuckTitle(stageLabel(stageOf(card)), formatHours(opsFlowById(card.flow)?.stuckAfterHours ?? 0)) };
}

export function rowModel(card: OrbitCard, ctx: ScreenCtx): CardRowModel {
  const stage = stageOf(card);
  return {
    id: card.id,
    title: card.title,
    place: card.place,
    stage: { label: stageLabel(stage), glyph: STAGE_GLYPH_OF[stage] },
    worker: workerModel(card, ctx),
    due: dueTag(card, ctx.copy),
    inStage: inStageTag(card, ctx),
  };
}
