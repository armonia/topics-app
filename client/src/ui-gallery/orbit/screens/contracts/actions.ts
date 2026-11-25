/**
 * Everything the contract screens change in the live world, in one place:
 * approving or signing a step of the chain (and moving the contract's card on
 * «Da fare» with it), asking for changes, closing an obligation with its proof, (allow-italian: quotes the Italian interface)
 * commenting on a clause, and drafting a new variation with its version, its
 * chain and its card. Each change goes through `model/live.ts`, writes the
 * log, says so in a toast, and tells the next person.
 */
import type { ApprovalStep, Contract, ContractVariant, ContractVersion, OrbitCard, StageId } from '../../../../ui/fixtures/orbit-org/types';
import { personaById, world } from '../../world';
import type { ReceiptModel } from '../../../../ui/record/model';
import type { ScreenCtx } from '../../../app/kit';
import {
  CONTRACTS_INITIAL, CONTRACTS_SLICE, KANBAN_INITIAL, KANBAN_SLICE, liveCards, withCard, withMove, withWorker,
  type ContractsSlice, type KanbanSlice,
} from '../../model/live';
import { actionLabel, currentVersion, formatMoney, formatShare, latestVersion, variantShare, versionValue } from '../../model/contracts';
import { SP } from '../../paths';
import { chainStage, fingerprint, isPublic, linkedCard, nextVariantCardId, registerNumber, stamp, stepAfter, valueClauseOf } from './model';

/** The words of what the next step does, for the card its person takes. */
function doingOf(ctx: ScreenCtx, action: ApprovalStep['action']): string {
  const d = ctx.copy.contracts.common.doing;
  return action === 'redige' ? d.draft : action === 'rivede' ? d.review : action === 'approva' ? d.approve : action === 'firma' ? d.sign : d.countersign; // allow-italian: data codes compared by value
}

const stageName = (id: StageId) => world().stages.find((s) => s.id === id)?.label ?? id;

function setContracts(ctx: ScreenCtx, fn: (prev: ContractsSlice) => ContractsSlice) {
  const [, set] = ctx.slice<ContractsSlice>(CONTRACTS_SLICE, CONTRACTS_INITIAL);
  set((prev) => fn({ ...CONTRACTS_INITIAL, ...prev }));
}

function setKanban(ctx: ScreenCtx, fn: (prev: KanbanSlice) => KanbanSlice) {
  const [, set] = ctx.slice<KanbanSlice>(KANBAN_SLICE, KANBAN_INITIAL);
  set((prev) => fn({ ...KANBAN_INITIAL, ...prev }));
}

/** Moves the contract's card to the column of the step the chain waits on next, in the hands of that step's person. */
function moveCard(ctx: ScreenCtx, c: Contract, next: ApprovalStep | undefined, doneBy: string) {
  const card = linkedCard(c, liveCards(ctx.state));
  if (!card) return undefined;
  const stage: StageId = next ? chainStage(next.action) : 'fatto'; // allow-italian: stage id
  setKanban(ctx, (prev) => {
    const moved = withMove(prev, card, stage, doneBy, ctx.now);
    return next ? withWorker(moved, card.id, { kind: 'person', id: next.who, doing: doingOf(ctx, next.action), since: ctx.now }) : moved;
  });
  return { card, stage: stageName(stage) };
}

/** A step of approval, review or drafting marked done by the reader. */
export function approveStep(ctx: ScreenCtx, c: Contract, step: ApprovalStep, note: string) {
  const t = ctx.copy.contracts;
  const v = latestVersion(c).n;
  setContracts(ctx, (prev) => ({ ...prev, approvals: { ...prev.approvals, [`${c.id}:${step.id}`]: { at: ctx.now, by: ctx.persona.id, ...(note ? { note } : {}) } } }));
  const next = stepAfter(c.approvals, step.id);
  const moved = moveCard(ctx, c, next, ctx.persona.id);
  const action = actionLabel[step.action];
  ctx.log(t.log.approved(action, v, c.title), 'case', SP.signatures(c.id));
  const nextName = next ? `${personaById(next.who)?.name ?? next.who}, ${actionLabel[next.action].toLowerCase()}` : '';
  ctx.toast({
    tone: 'ok',
    title: t.toast.approved(action),
    body: [next ? t.toast.approvedBody(nextName) : t.toast.complete, moved ? `${moved.card.id} → ${moved.stage}` : ''].filter(Boolean).join(' · '),
    ...(moved ? { action: { label: t.toast.openCard, path: SP.card(moved.card.id) } } : {}),
  });
  if (next) ctx.notify({ title: t.notify.yourTurn(actionLabel[next.action], c.title), body: note || undefined, path: SP.signatures(c.id), tone: 'info', to: [next.who] });
}

/** Changes asked on the current step: back to who drafted it, the chain starts again from this step. */
export function requestChanges(ctx: ScreenCtx, c: Contract, step: ApprovalStep, note: string) {
  const t = ctx.copy.contracts;
  const author = c.approvals.find((s) => s.action === 'redige')?.who ?? c.owner; // allow-italian: data code compared by value
  setContracts(ctx, (prev) => ({ ...prev, changes: { ...(prev.changes ?? {}), [`${c.id}:${step.id}`]: { at: ctx.now, by: ctx.persona.id, note } } }));
  const card = linkedCard(c, liveCards(ctx.state));
  if (card) {
    setKanban(ctx, (prev) => withWorker(withMove(prev, card, 'lavorazione', ctx.persona.id, ctx.now), card.id, { kind: 'person', id: author, doing: t.common.doing.fix, since: ctx.now }));
  }
  ctx.log(t.log.changes(c.title, note), 'case', SP.signatures(c.id));
  ctx.toast({ tone: 'info', title: t.toast.changes(personaById(author)?.name ?? author), body: card ? `${card.id} → ${stageName('lavorazione')}` : undefined });
  ctx.notify({ title: t.notify.changes(c.title), body: note, path: SP.signatures(c.id), tone: 'warn', to: [author] });
}

/** The receipt shown after a signature or a countersignature. */
export type SignatureReceipt = ReceiptModel & { path?: string };

/** The digital signature of the version under approval, simulated with a visible job and a receipt. */
export function signStep(ctx: ScreenCtx, c: Contract, step: ApprovalStep, onReceipt: (r: SignatureReceipt) => void) {
  const t = ctx.copy.contracts;
  const s = t.signatures.job;
  const version = latestVersion(c);
  const v = version.n;
  ctx.startJob({
    id: `sign:${c.id}`,
    title: s.signTitle(v),
    steps: [{ label: s.certificate, ms: 500 }, { label: s.hash, ms: 450 }, { label: s.sign, ms: 650 }, { label: s.timestamp, ms: 450 }],
    onDone: (ok) => {
      if (!ok) return;
      const at = ctx.now;
      const hash = fingerprint(`${c.id}:${v}:${version.clauses.map((x) => x.text).join('\n')}`);
      const register = registerNumber(`${c.id}:${v}:${at}`, at.slice(0, 4));
      setContracts(ctx, (prev) => ({
        ...prev,
        approvals: { ...prev.approvals, [`${c.id}:${step.id}`]: { at, by: ctx.persona.id, note: t.signatures.receipt.register(register) } },
        signed: { ...prev.signed, [c.id]: v },
        receipts: { ...(prev.receipts ?? {}), [`${c.id}:v${v}`]: { at, by: ctx.persona.id, hash, register } },
      }));
      const next = stepAfter(c.approvals, step.id);
      /* The card stays open while a step is left (the countersignature): it goes to whoever does that step. Only a chain that ends with the signature closes it. */
      const card = linkedCard(c, liveCards(ctx.state));
      let moved: { card: OrbitCard; stage: string } | undefined;
      if (next) moved = moveCard(ctx, c, next, ctx.persona.id);
      else if (card) {
        setKanban(ctx, (prev) => withWorker(withMove(prev, card, 'fatto', ctx.persona.id, at), card.id, { kind: 'person', id: ctx.persona.id, doing: t.common.doing.signed(t.common.version(v)), since: at })); // allow-italian: stage id compared by value
        moved = { card, stage: stageName('fatto') }; // allow-italian: stage id compared by value
      }
      ctx.log(t.log.signed(v, c.title, register), 'case', SP.attachment(c.id, `signed-v${v}`));
      ctx.toast({ tone: 'ok', title: t.toast.signed(v), body: moved ? `${moved.card.id} → ${moved.stage}` : undefined, action: { label: t.signatures.receipt.openCopy, path: SP.attachment(c.id, `signed-v${v}`) } });
      ctx.notify({ title: t.notify.signed(c.title, v), body: register, path: SP.attachment(c.id, `signed-v${v}`), tone: 'ok', to: [c.owner] });
      if (next) ctx.notify({ title: t.notify.yourTurn(actionLabel[next.action], c.title), path: SP.signatures(c.id), tone: 'info', to: [next.who] });
      const r = t.signatures.receipt;
      onReceipt({
        id: `sign:${c.id}:${v}`,
        title: r.signTitle,
        at: r.at(stamp(at)),
        lines: [r.document(c.title, v), r.signer(ctx.persona.name), r.hash(hash), r.register(register)],
        path: SP.attachment(c.id, `signed-v${v}`),
      });
    },
  });
}

/** The countersignature of the other side: the signed copy goes out by PEC and comes back signed. */
export function countersignStep(ctx: ScreenCtx, c: Contract, step: ApprovalStep, onReceipt: (r: SignatureReceipt) => void) {
  const t = ctx.copy.contracts;
  const s = t.signatures.job;
  ctx.startJob({
    id: `countersign:${c.id}`,
    title: s.countersignTitle,
    steps: [{ label: s.pec(c.counterparty), ms: 600 }, { label: s.delivery, ms: 500 }, { label: s.countersigned, ms: 600 }],
    onDone: (ok) => {
      if (!ok) return;
      const at = ctx.now;
      const delivery = `opec-${fingerprint(`${c.id}:${at}:pec`).slice(0, 10)}`;
      const r = t.signatures.receipt;
      setContracts(ctx, (prev) => ({ ...prev, approvals: { ...prev.approvals, [`${c.id}:${step.id}`]: { at, by: ctx.persona.id, note: r.delivery(delivery) } } }));
      const card = linkedCard(c, liveCards(ctx.state));
      if (card) setKanban(ctx, (prev) => withMove(prev, card, 'fatto', ctx.persona.id, at)); // allow-italian: stage id compared by value
      ctx.log(t.log.countersigned(c.title, c.counterparty), 'share', SP.signatures(c.id));
      ctx.toast({ tone: 'ok', title: t.toast.countersigned, body: c.counterparty });
      onReceipt({ id: `countersign:${c.id}`, title: r.countersignTitle, at: r.at(stamp(at)), lines: [r.pec(c.counterparty), r.delivery(delivery), r.countersigned(stamp(at))] });
    },
  });
}

export function closeObligation(ctx: ScreenCtx, c: Contract, obligationId: string, proof: string) {
  const t = ctx.copy.contracts;
  const o = c.obligations.find((x) => x.id === obligationId);
  setContracts(ctx, (prev) => ({ ...prev, obligationsDone: { ...prev.obligationsDone, [obligationId]: { at: ctx.now, by: ctx.persona.id, proof } } }));
  ctx.log(t.log.obligation(o?.what ?? obligationId, c.title), 'case', o ? SP.clause(c.id, o.clause) : SP.contract(c.id));
  ctx.toast({ tone: 'ok', title: t.toast.obligation, body: o?.what });
}

/** A clause as the log names it: `art. 9`, read from the version the comment is on. */
function clauseName(ctx: ScreenCtx, c: Contract, clause: string, version?: number): string {
  const v = (version !== undefined ? c.versions.find((x) => x.n === version) : undefined) ?? currentVersion(c);
  return ctx.copy.contracts.common.clause(v.clauses.find((x) => x.id === clause)?.n ?? clause);
}

export function addComment(ctx: ScreenCtx, c: Contract, clause: string, version: number, text: string) {
  const t = ctx.copy.contracts;
  setContracts(ctx, (prev) => ({
    ...prev,
    comments: [...prev.comments, { id: `${c.id}:cm-${prev.comments.length + 1}-${ctx.now.slice(11, 16).replace(':', '')}`, clause, version, author: ctx.persona.id, at: ctx.now, text }],
  }));
  const label = clauseName(ctx, c, clause, version);
  ctx.log(t.log.comment(label, c.title), 'case', SP.clause(c.id, clause));
  ctx.toast({ tone: 'ok', title: t.toast.comment, body: label });
}

export function replyComment(ctx: ScreenCtx, c: Contract, commentId: string, text: string) {
  const t = ctx.copy.contracts;
  const cm = c.comments.find((x) => x.id === commentId);
  setContracts(ctx, (prev) => ({ ...prev, replies: { ...prev.replies, [commentId]: [...(prev.replies[commentId] ?? []), { author: ctx.persona.id, at: ctx.now, text }] } }));
  const label = cm ? clauseName(ctx, c, cm.clause, cm.version) : '';
  ctx.log(t.log.reply(label, c.title), 'case', cm ? SP.clause(c.id, cm.clause) : SP.contract(c.id));
  ctx.toast({ tone: 'ok', title: t.toast.reply, body: label });
}

export function resolveComment(ctx: ScreenCtx, c: Contract, commentId: string) {
  const t = ctx.copy.contracts;
  const cm = c.comments.find((x) => x.id === commentId);
  setContracts(ctx, (prev) => ({ ...prev, resolved: [...prev.resolved, commentId] }));
  const label = cm ? clauseName(ctx, c, cm.clause, cm.version) : '';
  ctx.log(t.log.resolved(label, c.title), 'case', cm ? SP.clause(c.id, cm.clause) : SP.contract(c.id));
  ctx.toast({ tone: 'ok', title: t.toast.resolved, body: label });
}

/** The amount in euro written in a clause, replaced by a new one; the clause unchanged when it names none. */
function withAmount(text: string, amount: string): string {
  return text.replace(/euro \d[\d.]*,\d{2}/, `euro ${amount}`);
}

/** The share of the initial value a new value means, for a contract and the version it would be. */
export function shareFor(c: Contract, value: number): number {
  const n = latestVersion(c).n + 1;
  const probe: Contract = { ...c, versions: [...c.versions, { ...currentVersion(c), n, signed: false, value }] };
  return variantShare(probe, n);
}

/**
 * A new variation from the interview: a draft version (the text in force with
 * the touched clauses marked and the amount rewritten), the variation record,
 * a fresh approval chain, and a card on the flow of contract variations for the agent to
 * prepare the comparison. Then the comparison opens.
 */
export function draftVariant(ctx: ScreenCtx, c: Contract, answers: { reason: string; clauses: string[]; value?: number }) {
  const t = ctx.copy.contracts;
  const vt = t.variant;
  const base = currentVersion(c);
  const n = latestVersion(c).n + 1;
  const at = ctx.now;
  const amount = answers.value !== undefined ? formatMoney(answers.value) : undefined;
  const valueClause = valueClauseOf(base)?.id;
  const clauses = base.clauses.map((cl) => {
    if (!answers.clauses.includes(cl.id)) return cl;
    let text = cl.text;
    if (amount && cl.id === valueClause) {
      const replaced = withAmount(text, amount);
      text = replaced === text ? `${text} ${vt.newAmount(amount)}` : replaced;
    }
    return { ...cl, text: `${text} ${vt.draftNote(answers.reason)}` };
  });
  const version: ContractVersion = { n, author: ctx.persona.id, draftedBy: 'agent:ag-contratti', at, reason: vt.versionReason(answers.reason), clauses, ...(answers.value !== undefined ? { value: answers.value } : {}) };
  const share = formatShare(answers.value !== undefined ? shareFor(c, answers.value) : 0);
  const cards = liveCards(ctx.state);
  const cardId = nextVariantCardId(cards);
  const variant: ContractVariant = { id: `var-${c.id}-${n}`, title: answers.reason, reason: answers.reason, version: n, status: 'in-corso', card: cardId, at };
  const over = isPublic(c) && answers.value !== undefined && Math.abs(shareFor(c, answers.value)) >= 10;
  const author = ctx.persona.id;
  // A review step asks for approve:contracts: the reviewer is the Legal office, or the owner when the Legal office wrote it; nobody else may act on it, so without one the step is left out.
  const canReview = (id: string) => Boolean(world().people.roles.find((r) => r.id === personaById(id)?.role)?.permissions.includes('approve:contracts'));
  const reviewer = [world().people.legalLeadId, c.owner].find((id) => id !== author && canReview(id));
  const chain: ApprovalStep[] = [
    { id: `v${n}-1`, who: author, action: 'redige', state: 'fatto', at, note: vt.chain.draft }, // allow-italian: data codes
    ...(reviewer ? [{ id: `v${n}-2`, who: reviewer, action: 'rivede', state: 'in-attesa', note: vt.chain.review } satisfies ApprovalStep] : []), // allow-italian: data codes
    { id: `v${n}-3`, who: world().people.directorId, action: 'approva', state: reviewer ? 'da-fare' : 'in-attesa', note: over ? `${vt.chain.approve(share)} ${vt.chain.overThreshold}` : vt.chain.approve(share) }, // allow-italian: data codes
    { id: `v${n}-4`, who: world().people.directorId, action: 'firma', state: 'da-fare' }, // allow-italian: data codes
    { id: `v${n}-5`, who: world().people.legalLeadId, action: 'controfirma', state: 'da-fare', note: isPublic(c) ? vt.chain.countersignPublic : vt.chain.countersignPrivate }, // allow-italian: data codes
  ];
  const nextWho = reviewer ?? world().people.directorId;
  const clauseList = answers.clauses.map((id) => t.common.clause(base.clauses.find((x) => x.id === id)?.n ?? id)).join(', ');
  const valueLine = amount ? vt.card.lines.value(`${t.common.euro(amount)}, ${share}`) : vt.card.lines.valueSame;
  const lines = [vt.card.lines.contract(c.cig ? `${c.title}, CIG ${c.cig}` : c.title), vt.card.lines.reason(answers.reason), vt.card.lines.clauses(clauseList), valueLine, vt.card.lines.by(ctx.persona.name, stamp(at))];
  const card: OrbitCard = {
    id: cardId, flow: world().flowRoles.variants, step: 's1',
    title: vt.card.title(answers.reason),
    detail: vt.card.detail(c.counterparty, n, share),
    place: c.counterparty,
    history: [{ stage: 'arrivo', at, by: author }],
    worker: { kind: 'agent', id: world().people.contractsAgentId, doing: vt.card.doing, since: at },
    reviewer: world().people.legalLeadId,
    priority: 'normale',
    originals: [{ id: 'request', name: vt.card.original, kind: 'letter', from: vt.card.originalFrom, at, lines }],
    values: [
      { label: vt.card.values.reason, value: answers.reason, doc: 'request', quote: answers.reason, confidence: 100 },
      { label: vt.card.values.clauses, value: clauseList, doc: 'request', quote: clauseList, confidence: 100 },
      ...(amount ? [{ label: vt.card.values.value, value: t.common.euro(amount), doc: 'request', quote: t.common.euro(amount), confidence: 100 }] : []),
    ],
    proposal: vt.card.proposal(n, base.n),
    links: { contract: c.id, ...(answers.clauses[0] ? { clause: answers.clauses[0] } : {}) },
  };
  setContracts(ctx, (prev) => ({
    ...prev,
    versions: { ...prev.versions, [c.id]: [...(prev.versions[c.id] ?? []), version] },
    variants: { ...prev.variants, [c.id]: [...(prev.variants[c.id] ?? []), variant] },
    chains: { ...(prev.chains ?? {}), [c.id]: chain },
  }));
  setKanban(ctx, (prev) => withCard(prev, card));
  ctx.log(t.log.variant(n, c.title, cardId), 'case', SP.compare(c.id, base.n, n));
  ctx.toast({ tone: 'ok', title: t.toast.variant(n, cardId), body: t.toast.variantBody, action: { label: t.toast.openCard, path: SP.card(cardId) } });
  ctx.notify({ title: t.notify.variant(c.title), body: `${cardId} · ${t.common.version(n)}`, path: SP.compare(c.id, base.n, n), tone: 'info', to: [nextWho] });
  ctx.go(SP.compare(c.id, base.n, n));
}

/** The value of a version in words: `11.853.030,20 €`. */
export const moneyOf = (ctx: ScreenCtx, c: Contract, n: number) => ctx.copy.contracts.common.euro(formatMoney(versionValue(c, n)));

/**
 * A day as the deadlines print it, with how far it is: in days up to two
 * months, then in months and years (1241 days read as 3 years and 5 months).
 */
export function relDay(ctx: Pick<ScreenCtx, 'copy'>, day: string, today: string): string {
  const t = ctx.copy.contracts.common;
  const n = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (n === 0) return t.today;
  if (Math.abs(n) < 60) return n > 0 ? t.inDays(n) : t.daysAgo(-n);
  const months = Math.round(Math.abs(n) / 30.4375);
  const span = t.span(Math.floor(months / 12), months % 12);
  return n > 0 ? t.inSpan(span) : t.spanAgo(span);
}

