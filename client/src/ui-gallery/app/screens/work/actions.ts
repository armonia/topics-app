/**
 * What the reader does to a case, as state changes with their trace: confirm,
 * close as not ours, correct a value, hand it to someone, answer the
 * assistant, run the action that closes the phase. Every change goes through
 * `ctx.updateCase` and leaves a line in the log that cannot be edited
 * (`ctx.log`); anything that leaves the system is a job with visible progress
 * that ends in a receipt kept on the case.
 */
import type { CaseSeed, StepState } from '../../../../ui/fixtures/org/types';
import { PERSONAS } from '../../../../ui/fixtures/org/people';
import { recordName } from '../../../../ui/fixtures/work';
import type { ScreenCtx } from '../../kit';
import type { CaseLive } from '../../store/state';
import { caseSeed, type LiveCase } from '../../store/cases';
import { answer } from './assistant';
import { decodeAdded, encodeAdded, recordPathOf, type AddedBlock } from './adapters';
import { CLOSED, stamp } from './format';

const who = (ctx: ScreenCtx) => ctx.persona.name;

/** The steps of a case with the current one done and the next one current. */
function advancedSteps(seed: CaseSeed, live: CaseLive): Record<string, StepState> {
  const merged = seed.steps.map((s) => ({ id: s.id, state: (live.steps?.[s.id] ?? s.state) as StepState }));
  const out: Record<string, StepState> = { ...(live.steps ?? {}) };
  const current = merged.find((s) => s.state === 'current');
  if (current) out[current.id] = 'done';
  const afterCurrent = current ? merged.slice(merged.indexOf(current) + 1) : merged;
  const next = afterCurrent.find((s) => s.state === 'todo');
  if (next) out[next.id] = 'current';
  return out;
}

const addEvent = (live: CaseLive, ctx: ScreenCtx, what: string) => [...(live.events ?? []), { at: stamp(ctx.now), who: who(ctx), what }];

/** The assistant's checklist items that confirming the case ticks. */
const confirmChecks = (c: CaseSeed): Record<string, boolean> =>
  Object.fromEntries((c.assistant?.checklist ?? []).filter((x) => x.closedByConfirm).map((x) => [x.id, true]));

export function confirmCase(ctx: ScreenCtx, c: LiveCase, silent = false) {
  const w = ctx.copy.work;
  // The number Halley assigns on confirmation comes from the fixture; the date is the day of the confirmation.
  const assigned = caseSeed(c.id)?.protocol;
  ctx.updateCase(c.id, (live) => ({
    ...live,
    status: 'in-lavorazione',
    ...(assigned && !live.protocol ? { protocol: { number: assigned.number, date: ctx.now.slice(0, 10) } } : {}),
    steps: advancedSteps(c, live),
    checklist: { ...(live.checklist ?? {}), ...confirmChecks(c) },
    events: addEvent(live, ctx, w.events.confirmed),
  }));
  ctx.log(w.log.confirmed(recordName(c.id)), 'case', recordPathOf(c));
  if (!silent) {
    ctx.toast({ tone: 'ok', title: w.toast.confirmed(recordName(c.id)), action: { label: w.toast.openRecord, path: recordPathOf(c) } });
  }
}

export function rejectCase(ctx: ScreenCtx, c: LiveCase) {
  const w = ctx.copy.work;
  ctx.confirm({
    title: w.inbox.rejectTitle(c.title),
    body: w.inbox.rejectBody,
    confirmLabel: w.inbox.rejectConfirm,
    tone: 'danger',
    onConfirm: () => {
      ctx.updateCase(c.id, (live) => ({ ...live, status: CLOSED, events: addEvent(live, ctx, w.events.notForUs) }));
      ctx.log(w.log.closed(recordName(c.id)), 'case', recordPathOf(c));
      ctx.toast({ tone: 'info', title: w.toast.closed(recordName(c.id)), body: w.toast.closedBody });
    },
  });
}

/** Sets the value of a field: confirmed as it stands, or typed over. */
export function setFieldValue(ctx: ScreenCtx, c: LiveCase, fieldId: string, value: string) {
  const w = ctx.copy.work;
  const field = c.fields.find((f) => f.id === fieldId);
  if (!field) return;
  ctx.updateCase(c.id, (live) => ({
    ...live,
    values: { ...(live.values ?? {}), [fieldId]: value },
    events: addEvent(live, ctx, w.events.valueSet(field.label, value)),
  }));
  ctx.log(w.log.valueSet(recordName(c.id), field.label, value), 'case', recordPathOf(c));
  ctx.toast({ tone: 'ok', title: w.toast.valueSet(field.label), body: value });
}

export function assignCase(ctx: ScreenCtx, c: LiveCase, personaId: string) {
  const w = ctx.copy.work;
  const person = PERSONAS.find((p) => p.id === personaId);
  if (!person) return;
  ctx.updateCase(c.id, (live) => ({ ...live, assignee: personaId, events: addEvent(live, ctx, w.events.assigned(person.name)) }));
  ctx.log(w.log.assigned(recordName(c.id), person.name), 'case', recordPathOf(c));
  ctx.toast({ tone: 'ok', title: w.toast.assigned(person.name) });
  ctx.notify({ title: w.notify.assigned(recordName(c.id)), body: c.title, path: recordPathOf(c), tone: 'info', to: [personaId] });
}

export function decideProposal(ctx: ScreenCtx, c: LiveCase, slot: { from: 'seed' | 'added'; index: number }, decision: 'accept' | 'discard') {
  const w = ctx.copy.work;
  if (slot.from === 'seed') {
    ctx.updateCase(c.id, (live) => ({ ...live, proposals: { ...(live.proposals ?? {}), [String(slot.index)]: decision } }));
  } else {
    ctx.updateCase(c.id, (live) => {
      const list = [...(live.draftAdded ?? [])];
      if (decision === 'discard') list.splice(slot.index, 1);
      else list[slot.index] = encodeAdded({ ...decodeAdded(list[slot.index]), proposal: false });
      return { ...live, draftAdded: list };
    });
  }
  ctx.log(decision === 'accept' ? w.log.proposalAccepted(recordName(c.id)) : w.log.proposalDiscarded(recordName(c.id)), 'case', recordPathOf(c));
  ctx.toast({ tone: decision === 'accept' ? 'ok' : 'info', title: decision === 'accept' ? w.toast.proposalAccepted : w.toast.proposalDiscarded });
}

export function addParagraph(ctx: ScreenCtx, c: LiveCase, block: AddedBlock) {
  const w = ctx.copy.work;
  ctx.updateCase(c.id, (live) => ({ ...live, draftAdded: [...(live.draftAdded ?? []), encodeAdded(block)] }));
  ctx.log(w.log.paragraphAdded(recordName(c.id)), 'case', recordPathOf(c));
}

export function saveDraft(ctx: ScreenCtx, c: LiveCase) {
  const w = ctx.copy.work;
  ctx.updateCase(c.id, (live) => ({ ...live, events: addEvent(live, ctx, w.events.draftSaved(c.draft?.file ?? '')) }));
  ctx.log(w.log.draftSaved(recordName(c.id)), 'case', recordPathOf(c));
  ctx.toast({ tone: 'ok', title: w.toast.draftSaved, body: c.draft?.meta ? c.draft.file : undefined });
}

/** The AI reads the last paragraph and proposes a clearer one: it lands as a proposal, never merged. */
export function improveDraft(ctx: ScreenCtx, c: LiveCase) {
  const w = ctx.copy.work;
  ctx.startJob({
    id: `case.${c.id}.improve`,
    title: w.record.improveJob,
    steps: w.record.improveSteps.map((label) => ({ label, ms: 700 })),
    onDone: (ok) => {
      if (!ok) return;
      ctx.updateCase(c.id, (live) => ({ ...live, draftAdded: [...(live.draftAdded ?? []), encodeAdded({ text: w.record.improveProposal, proposal: true })] }));
      ctx.log(w.log.improved(recordName(c.id)), 'case', recordPathOf(c));
      ctx.toast({ tone: 'info', title: w.toast.improved });
    },
  });
}

export function toggleCheck(ctx: ScreenCtx, c: LiveCase, id: string, current: boolean) {
  ctx.updateCase(c.id, (live) => ({ ...live, checklist: { ...(live.checklist ?? {}), [id]: !current } }));
}

export function askAssistant(ctx: ScreenCtx, c: LiveCase, question: string) {
  const text = question.trim();
  const w = ctx.copy.work;
  ctx.updateCase(c.id, (live) => ({
    ...live,
    chat: [
      ...(live.chat ?? []),
      ...(text ? [{ role: 'user' as const, text }] : []),
      { role: 'assistant' as const, text: JSON.stringify(text ? answer(text, c, ctx.copy) : [w.assistant.canAnswer]) },
    ],
  }));
}

/* ---------- the action that closes the phase ---------- */

const CLOSES_CASE = new Set(['pay', 'grant', 'reject-invoice', 'reply']);

/** Whether the draft still holds a proposal nobody decided: the filing stops on it. */
export function pendingProposals(c: LiveCase): number {
  const seed = (c.draft?.blocks ?? []).filter((b, i) => b.kind === 'proposal' && !c.live.proposals?.[String(i)]).length;
  const added = (c.live.draftAdded ?? []).filter((r) => decodeAdded(r).proposal).length;
  return seed + added;
}

export function runPrimary(ctx: ScreenCtx, c: LiveCase) {
  const w = ctx.copy.work;
  const action = c.primaryAction;
  const pending = pendingProposals(c);
  const steps = w.record.jobSteps[action.kind].map((label, i) => ({ label, ms: 900, fails: i === 0 && pending > 0 }));
  ctx.startJob({
    id: `case.${c.id}.primary`,
    title: action.label,
    steps,
    onDone: (ok) => {
      if (!ok) {
        ctx.toast({ tone: 'error', title: w.toast.actionFailed(action.label), body: w.toast.actionFailedBody(pending) });
        ctx.log(w.log.actionFailed(recordName(c.id), action.label), 'case', recordPathOf(c));
        return;
      }
      ctx.updateCase(c.id, (live) => ({
        ...live,
        status: CLOSES_CASE.has(action.kind) ? CLOSED : 'in-attesa',
        steps: advancedSteps(c, live),
        receipts: [...(live.receipts ?? []), { at: stamp(ctx.now), title: action.receipt.title, lines: action.receipt.lines }],
        events: addEvent(live, ctx, w.events.receipt(action.receipt.title)),
      }));
      ctx.log(w.log.actionDone(recordName(c.id), action.label), 'case', recordPathOf(c));
      ctx.toast({ tone: 'ok', title: action.receipt.title, action: { label: w.toast.openReceipt, path: recordPathOf(c) } });
      ctx.notify({ title: action.receipt.title, body: `${recordName(c.id)} · ${c.title}`, path: recordPathOf(c), tone: 'ok' });
    },
  });
}

export function reopenCase(ctx: ScreenCtx, c: LiveCase) {
  const w = ctx.copy.work;
  ctx.updateCase(c.id, (live) => ({ ...live, status: 'in-lavorazione', events: addEvent(live, ctx, w.events.reopened) }));
  ctx.log(w.log.reopened(recordName(c.id)), 'case', recordPathOf(c));
  ctx.toast({ tone: 'ok', title: w.toast.reopened(recordName(c.id)) });
}

/** The primary action of a case: a case still to be confirmed asks to be confirmed first. */
export function startPrimary(ctx: ScreenCtx, c: LiveCase) {
  const w = ctx.copy.work.record;
  if (c.status !== 'da-confermare') {
    runPrimary(ctx, c);
    return;
  }
  ctx.confirm({
    title: w.confirmFirstTitle,
    body: w.confirmFirstBody,
    confirmLabel: w.confirmFirstConfirm,
    onConfirm: () => {
      confirmCase(ctx, c, true);
      runPrimary(ctx, c);
    },
  });
}
