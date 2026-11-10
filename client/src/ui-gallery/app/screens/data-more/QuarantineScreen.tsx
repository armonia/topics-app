/**
 * q02 live: one item stopped in quarantine. The person who may unblock
 * confirms (with a reason), rejects, or asks the other party, and every
 * decision is logged and shown on the page; a question leaves the item
 * stopped and shows its receipt.
 */
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { TextArea } from '../../../../ui/primitives/Field';
import { Chip } from '../../../../ui/primitives/Chip';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { QuarantineView } from '../../../../ui/quality/QuarantineView';
import type { QuarantineModel } from '../../../../ui/quality/model';
import { QUARANTINE } from '../../../../ui/fixtures/quality';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import type { QuarantineDecision, QuarantineDecisions } from './quality';

const timeOf = (iso: string) => `${formatDay(iso.slice(0, 10))} ${iso.slice(11, 16)}`;

export function QuarantineScreen({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const d = ctx.copy.dataMore;
  const t = d.quarantine;
  const [decisions, setDecisions] = ctx.slice<QuarantineDecisions>('quarantine', {});
  const [reason, setReason] = useState<{ text: string; tried: boolean } | null>(null);
  const seed = QUARANTINE.find((x) => x.id === id);
  if (!seed) {
    return <EmptyState icon={ShieldAlert} title={t.notFound} action={<Button variant="primary" onClick={() => ctx.go(P.quality())}>{t.back}</Button>} />;
  }
  const decision = decisions[id];
  const decide = (next: QuarantineDecision, what: string, tone: 'ok' | 'info' | 'warn') => {
    setDecisions((prev) => ({ ...prev, [id]: next }));
    ctx.log(what, 'case', P.qualityItem(id));
    ctx.toast({ tone, title: what, action: { label: t.backToQuality, path: P.quality() } });
  };
  const confirm = () => {
    if (!seed.actions) return;
    if (!reason || !reason.text.trim()) { setReason(reason && { ...reason, tried: true }); return; }
    decide({ status: 'confirmed', at: ctx.now, by: ctx.persona.id, reason: reason.text.trim() }, d.log.confirmed(seed.title, seed.where), 'ok');
    ctx.notify({ title: seed.actions.confirm.done, body: seed.where, path: P.qualityItem(id), tone: 'ok' });
    setReason(null);
  };
  const reject = () => {
    const a = seed.actions;
    if (!a) return;
    ctx.confirm({
      title: a.reject.confirmTitle,
      body: a.reject.confirmBody,
      confirmLabel: a.reject.label,
      tone: 'danger',
      onConfirm: () => {
        decide({ status: 'rejected', at: ctx.now, by: ctx.persona.id }, d.log.rejected(seed.title, seed.where), 'warn');
        ctx.notify({ title: a.reject.done, body: seed.where, path: P.qualityItem(id), tone: 'warn' });
      },
    });
  };
  const ask = () => {
    const a = seed.actions?.ask;
    if (!a) return;
    ctx.startJob({
      id: `ask-${id}`,
      title: a.label,
      steps: a.steps.map((label, i) => ({ label, ms: 600 + i * 200 })),
      onDone: () => {
        const receipt = { title: t.receipt.title, lines: [t.receipt.to(a.to), t.receipt.subject(a.subject), t.receipt.accepted(timeOf(ctx.now)), t.receipt.delivered(timeOf(ctx.now))] };
        decide({ status: 'asked', at: ctx.now, by: ctx.persona.id, receipt }, d.log.asked(seed.title, seed.where), 'info');
      },
    });
  };

  const job = ctx.job(`ask-${id}`);
  const final = decision?.status === 'confirmed' || decision?.status === 'rejected';
  const outcome: QuarantineModel['outcome'] = seed.settled
    ? { tone: 'green', text: seed.settled.text, at: timeOf(seed.at) }
    : decision?.status === 'confirmed' && seed.actions
      ? { tone: 'green', text: seed.actions.confirm.done, at: `${timeOf(decision.at)} · ${decision.reason ?? ''}` }
      : decision?.status === 'rejected' && seed.actions
        ? { tone: 'green', text: seed.actions.reject.done, at: timeOf(decision.at) }
        : decision?.status === 'asked' && seed.actions
          ? { tone: 'amber', text: seed.actions.ask.done, at: timeOf(decision.at) }
          : undefined;
  const model: QuarantineModel = {
    title: seed.title,
    checkLabel: t.check(d.quality.dimensions[seed.dimension].name),
    headline: seed.headline,
    why: seed.why,
    risk: seed.risk,
    left: seed.left,
    right: seed.right,
    held: final ? { title: t.releasedTitle, body: t.releasedBody } : seed.held,
    history: [
      ...seed.history.map((h, i) => ({ id: `h${i}`, at: timeOf(h.at), text: h.what })),
      ...(decision ? [{ id: 'decision', at: timeOf(decision.at), text: outcome?.text ?? '' }] : []),
    ],
    unblockers: seed.unblockers,
    outcome,
    receipt: decision?.receipt,
  };

  const linkedCase = seed.caseId && caseSeed(seed.caseId) ? seed.caseId : undefined;
  const side = (
    <div className="flex flex-col gap-2 border-t border-app-border px-4 py-3.5">
      {linkedCase && <Button onClick={() => ctx.go(P.record(linkedCase))}>{t.openCase}</Button>}
      {!linkedCase && seed.office === 'ragioneria' && <Button onClick={() => ctx.go(P.data('fornitori'))}>{t.openSuppliers}</Button>}
      <Button onClick={() => ctx.go(P.quality())}>{t.backToQuality}</Button>
    </div>
  );
  const a = seed.actions;
  const asking = job?.status === 'running';
  const actions = a && !final && (
    <>
      <Button variant="primary" onClick={ctx.allow('approve', () => setReason({ text: '', tried: false }))} title={ctx.deniedTitle('approve')}>{a.confirm.label}</Button>
      {decision?.status !== 'asked' && <Button onClick={asking ? false : ctx.allow('edit:data', ask)} title={ctx.deniedTitle('edit:data')}>{asking ? job?.current : a.ask.label}</Button>}
      <Button variant="danger" onClick={ctx.allow('approve', reject)} title={ctx.deniedTitle('approve')}>{a.reject.label}</Button>
    </>
  );

  const statusChip = <Chip tone={outcome ? 'green' : 'amber'}>{outcome ? (seed.settled ? seed.settled.text : t.decided) : t.waiting}</Chip>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={ctx.phone ? [{ label: seed.title }] : [{ label: ctx.copy.data.root }, { label: d.quality.crumb }, { label: t.crumb }, { label: seed.title }]}
        status={ctx.phone ? undefined : statusChip}
      >
        {!ctx.phone && <span className="text-compact text-app-text-tertiary">{t.stopped(timeOf(seed.at), OFFICE_LABEL[seed.office])}</span>}
      </PaneHeader>
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">{statusChip}<span className="text-compact text-app-text-tertiary">{t.stopped(timeOf(seed.at), OFFICE_LABEL[seed.office])}</span></div>}
      <QuarantineView model={model} copy={ctx.copy} phone={ctx.phone} actions={actions || undefined} side={side} />
      {reason && a && (
        <Dialog
          title={a.confirm.confirmTitle}
          closeLabel={ctx.copy.common.close}
          onClose={() => setReason(null)}
          footer={<><Button onClick={() => setReason(null)}>{d.common.cancel}</Button><Button variant="primary" onClick={confirm}>{a.confirm.label}</Button></>}
        >
          <p className="mb-3 leading-6">{a.confirm.confirmBody}</p>
          <TextArea label={t.reason} value={reason.text} onChange={(v) => setReason({ ...reason, text: v })} hint={reason.tried && !reason.text.trim() ? t.reasonRequired : t.reasonHint} />
        </Dialog>
      )}
    </div>
  );
}
