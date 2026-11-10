/**
 * The readings every place of a contract shares, in words and tones: today in
 * the preview, the alerts of a contract, why a new variation cannot start, the
 * kinds of obligations and attachments (the signed copies made here among
 * them), the steps of the approval chain. No drawing here: the places do it.
 */
import type { ApprovalStep, Contract, Obligation } from '../../../../ui/fixtures/sarim-org/types';
import { personaById } from '../../world';
import type { AlertModel, ApprovalStepModel } from '../../../../ui/contracts/model';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { contractsSlice, liveCards } from '../../model/live';
import { SP } from '../../paths';
import { actionLabel, contractAlerts, currentVersion } from '../../model/contracts';
import { actorOf, currentStep, inForce, isExpired, runningVariant, stamp } from './model';

const ALERT_TONE: Record<'error' | 'warn' | 'info', Tone> = { error: 'red', warn: 'amber', info: 'blue' };

export const today = (ctx: ScreenCtx) => ctx.now.slice(0, 10);

/** The variation states of the data, in words. */
export function variantStateText(ctx: ScreenCtx, status: Contract['variants'][number]['status']): string {
  const s = ctx.copy.contracts.common.variantStates;
  return status === 'in-corso' ? s.running : status === 'approvata' ? s.approved : status === 'firmata' ? s.signed : s.rejected; // allow-italian: data codes compared by value
}

/** The alerts of a contract today, in the words and tones of the strip; one whose clause is on show says so. */
export function alertModels(ctx: ScreenCtx, c: Contract): AlertModel[] {
  const v = currentVersion(c);
  return contractAlerts(c, today(ctx), liveCards(ctx.state)).map((a) => ({
    id: a.id,
    tone: ALERT_TONE[a.tone],
    title: a.title,
    body: a.body,
    clauseLabel: a.clause ? ctx.copy.contracts.common.clause(v.clauses.find((x) => x.id === a.clause)?.n ?? a.clause) : undefined,
    here: Boolean(a.clause && ctx.path === SP.clause(c.id, a.clause)),
  }));
}

/** Why a new variation cannot start here, or undefined when it can. */
export function variantDenied(ctx: ScreenCtx, c: Contract): string | undefined {
  const d = ctx.copy.contracts.page.variantDenied;
  if (!ctx.can('edit:contracts')) return d.permission;
  const running = runningVariant(c);
  if (running) return d.running(running.version);
  if (isExpired(c, today(ctx))) return d.expired;
  if (!inForce(c, today(ctx))) return d.notInForce;
  return undefined;
}

/** The kind of an obligation in words and tone. */
export function obligationKind(ctx: ScreenCtx, kind: Obligation['kind']): { text: string; tone: Tone } {
  const k = ctx.copy.contracts.common.obligationKinds;
  if (kind === 'penale') return { text: k.penalty, tone: 'red' }; // allow-italian: data code compared by value
  if (kind === 'rinnovo') return { text: k.renewal, tone: 'violet' }; // allow-italian: data code compared by value
  if (kind === 'rendiconto') return { text: k.report, tone: 'blue' }; // allow-italian: data code compared by value
  if (kind === 'garanzia') return { text: k.guarantee, tone: 'amber' }; // allow-italian: data code compared by value
  if (kind === 'ricorrente') return { text: k.recurring, tone: 'neutral' }; // allow-italian: data code compared by value
  return { text: k.deadline, tone: 'neutral' };
}

/** The attachments of a contract, with the signed copies made in the preview. */
export function attachmentsOf(ctx: ScreenCtx, c: Contract): Array<{ id: string; name: string; kind: Contract['attachments'][number]['kind']; version?: number; at: string; lines: string[] }> {
  const receipts = contractsSlice(ctx.state).receipts ?? {};
  const made = Object.entries(receipts)
    .filter(([key]) => key.startsWith(`${c.id}:v`))
    .map(([key, r]) => {
      const n = Number(key.slice(c.id.length + 2));
      return { id: `signed-v${n}`, name: ctx.copy.contracts.attachment.signedCopy(n), kind: 'firmato' as const, version: n, at: r.at, lines: [] as string[] }; // allow-italian: data code
    });
  return [...made, ...c.attachments];
}

/** The kind of an attachment in words and tone. */
export function attachmentKind(ctx: ScreenCtx, kind: Contract['attachments'][number]['kind']): { text: string; tone: Tone } {
  const k = ctx.copy.contracts.common.attachmentKinds;
  if (kind === 'firmato') return { text: k.signed, tone: 'green' }; // allow-italian: data code compared by value
  if (kind === 'variante') return { text: k.variant, tone: 'amber' }; // allow-italian: data code compared by value
  if (kind === 'verbale') return { text: k.minutes, tone: 'blue' }; // allow-italian: data code compared by value
  if (kind === 'garanzia') return { text: k.guarantee, tone: 'violet' }; // allow-italian: data code compared by value
  return { text: k.attachment, tone: 'neutral' };
}

function whyOf(ctx: ScreenCtx, action: ApprovalStep['action']): string {
  const w = ctx.copy.contracts.signatures.why;
  return action === 'redige' ? w.draft : action === 'rivede' ? w.review : action === 'approva' ? w.approve : action === 'firma' ? w.sign : w.countersign; // allow-italian: data codes compared by value
}

/** The steps of a contract's chain as the chain draws them. */
export function approvalModels(ctx: ScreenCtx, c: Contract): ApprovalStepModel[] {
  const t = ctx.copy.contracts.signatures;
  const changes = contractsSlice(ctx.state).changes ?? {};
  const current = currentStep(c.approvals);
  return c.approvals.map((s, i): ApprovalStepModel => {
    const request = changes[`${c.id}:${s.id}`];
    const done = s.state === 'fatto'; // allow-italian: data code compared by value
    const isCurrent = s.id === current?.id;
    return {
      id: s.id,
      order: i + 1,
      who: actorOf(s.who),
      actionText: actionLabel[s.action],
      stateText: done ? t.states.done : isCurrent ? (request ? t.states.changes : t.states.waiting) : t.states.todo,
      stateTone: done ? 'green' : isCurrent ? (request ? 'amber' : 'blue') : 'neutral',
      at: s.at ? stamp(s.at) : undefined,
      note: s.note,
      why: whyOf(ctx, s.action),
      request: request ? t.request(personaById(request.by)?.name ?? request.by, stamp(request.at), request.note) : undefined,
      current: isCurrent,
    };
  });
}
