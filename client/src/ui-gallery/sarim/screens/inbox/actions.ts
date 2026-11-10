/**
 * What a person can do to a card of «Da fare», (allow-italian: quotes the Italian interface)
 * each through the functions of `model/live.ts` on the kanban slice, with a
 * line in the log and a toast: move it to a column, take it in hand, send it
 * back to its agent, correct a value the agent read, approve it. A card of
 * the contract variations flow is not closed here: closing or approving it opens a
 * confirmation that leads to the approvals and signatures of its contract.
 */
import type { SarimCard, StageId, Worker } from '../../../../ui/fixtures/sarim-org/types';
import { world } from '../../world';
import type { ScreenCtx } from '../../../app/kit';
import { KANBAN_INITIAL, KANBAN_SLICE, liveContractById, stageOf, withMove, withWorker, type KanbanSlice } from '../../model/live';
import { latestVersion } from '../../model/contracts';
import { SP } from '../../paths';
import { DONE, INCOMING, WORKING, moveCheck, stageLabel, whoName } from './model';

/** The agent that prepares the cards of the flow of a card. */
const flowAgent = (card: SarimCard) => world().opsFlows.find((f) => f.id === card.flow)?.agent ?? '';

function update(ctx: ScreenCtx, fn: (slice: KanbanSlice) => KanbanSlice) {
  const [, set] = ctx.slice<KanbanSlice>(KANBAN_SLICE, KANBAN_INITIAL);
  set((prev) => fn({ ...KANBAN_INITIAL, ...prev }));
}

/**
 * Who has the card after it moves: whoever its flow names for the first step
 * of that column (a person or an agent; a rule or a program runs under the
 * flow's agent); in «Fatto», the person who closed it. (allow-italian: quotes the Italian interface)
 */
function workerAfter(card: SarimCard, to: StageId, ctx: ScreenCtx): Worker {
  if (to === DONE) return { kind: 'person', id: ctx.persona.id, doing: ctx.copy.kanban.actions.closedDoing, since: ctx.now };
  const step = world().opsFlows.find((f) => f.id === card.flow)?.steps.find((s) => s.stage === to);
  if (!step) return card.worker;
  if (step.actor.kind === 'person' || step.actor.kind === 'agent') return { kind: step.actor.kind, id: step.actor.id, doing: step.title, since: ctx.now };
  return { kind: 'agent', id: flowAgent(card), doing: step.title, since: ctx.now };
}

function done(ctx: ScreenCtx, card: SarimCard, log: string, title: string) {
  const path = SP.card(card.id);
  ctx.log(log, 'case', path);
  ctx.toast({ tone: 'ok', title, body: `${card.id} · ${card.title}`, action: { label: ctx.copy.kanban.actions.openCard, path } });
}

function apply(ctx: ScreenCtx, card: SarimCard, to: StageId, approved: boolean) {
  const a = ctx.copy.kanban.actions;
  update(ctx, (s) => withWorker(withMove(s, card, to, ctx.persona.id, ctx.now), card.id, workerAfter(card, to, ctx)));
  if (approved) done(ctx, card, a.logApproved(card.id, card.title), a.toastApproved);
  else done(ctx, card, a.logMoved(card.id, card.title, stageLabel(to)), a.toastMoved(stageLabel(to)));
}

/** The confirmation that sends the approval of a contract card to its contract. */
export function openContractGate(ctx: ScreenCtx, card: SarimCard, contractId: string) {
  const a = ctx.copy.kanban.actions;
  const contract = liveContractById(ctx.state, contractId);
  const version = contract?.variants.find((v) => v.card === card.id)?.version ?? (contract ? latestVersion(contract).n : 1);
  const name = contract?.title ?? contractId;
  ctx.confirm({
    title: a.gateTitle,
    body: a.gateBody(card.id, name, version),
    confirmLabel: a.gateConfirm,
    onConfirm: () => {
      ctx.log(a.logGate(card.id, name), 'case', SP.signatures(contractId));
      ctx.go(SP.signatures(contractId));
    },
  });
}

/** A move asked by a drag, the «Sposta in…» menu or a button. (allow-italian: quotes the Italian interface) */
export function moveCard(ctx: ScreenCtx, card: SarimCard, to: StageId) {
  if (stageOf(card) === to) return;
  const check = moveCheck(card, to, ctx);
  if (check.kind === 'contract') {
    openContractGate(ctx, card, check.contract);
    return;
  }
  if (check.kind === 'denied') {
    ctx.toast({ tone: 'warn', title: check.reason, body: `${card.id} · ${card.title}` });
    return;
  }
  apply(ctx, card, to, false);
}

/** «Approva»: the card in «Da approvare» closes in «Fatto». (allow-italian: quotes the Italian interface) */
export function approveCard(ctx: ScreenCtx, card: SarimCard) {
  const check = moveCheck(card, DONE, ctx);
  if (check.kind === 'contract') {
    openContractGate(ctx, card, check.contract);
    return;
  }
  if (check.kind === 'denied') {
    ctx.toast({ tone: 'warn', title: check.reason, body: `${card.id} · ${card.title}` });
    return;
  }
  apply(ctx, card, DONE, true);
}

/** «Prendo io»: the person takes the card in hand; a card just arrived goes to work. (allow-italian: quotes the Italian interface) */
export function takeCard(ctx: ScreenCtx, card: SarimCard) {
  const a = ctx.copy.kanban.actions;
  update(ctx, (s) => {
    const moved = stageOf(card) === INCOMING ? withMove(s, card, WORKING, ctx.persona.id, ctx.now) : s;
    return withWorker(moved, card.id, { kind: 'person', id: ctx.persona.id, doing: a.takenDoing, since: ctx.now });
  });
  done(ctx, card, a.logTaken(card.id, card.title), a.toastTaken);
}

/** «Rimanda all'agente»: the flow's agent picks the card up again, back at work. (allow-italian: quotes the Italian interface) */
export function sendBackCard(ctx: ScreenCtx, card: SarimCard) {
  const a = ctx.copy.kanban.actions;
  const agent = flowAgent(card);
  const name = whoName(`agent:${agent}`).full;
  update(ctx, (s) => {
    const moved = stageOf(card) === WORKING ? s : withMove(s, card, WORKING, ctx.persona.id, ctx.now);
    return withWorker(moved, card.id, { kind: 'agent', id: agent, doing: a.sentBackDoing, since: ctx.now });
  });
  done(ctx, card, a.logSentBack(card.id, card.title, name), a.toastSentBack(name));
}

/** A value the agent read, corrected by hand: stored by label, read back by `liveCard`. */
export function correctValue(ctx: ScreenCtx, card: SarimCard, label: string, value: string) {
  const a = ctx.copy.kanban.actions;
  update(ctx, (s) => ({ ...s, values: { ...s.values, [card.id]: { ...(s.values[card.id] ?? {}), [label]: value } } }));
  done(ctx, card, a.logValue(card.id, label, value), a.toastValue(label));
}

/** Whether a value of the card was corrected by hand. */
export function isCorrected(ctx: ScreenCtx, cardId: string, label: string): boolean {
  const [slice] = ctx.slice<KanbanSlice>(KANBAN_SLICE, KANBAN_INITIAL);
  return slice.values?.[cardId]?.[label] !== undefined;
}
