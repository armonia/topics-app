/**
 * A record open to work on it (x06): the phases of its flow, its documents,
 * the draft with the AI's proposals, the assistant of the record. Every
 * control changes the case (`updateCase`) and leaves a line in the log; the
 * action that closes the phase is a job with visible progress that ends in a
 * receipt kept on the record.
 */
import { Bot, CircleAlert, CircleCheck, FileText, Hourglass, Lock, MoreHorizontal, Sparkles, User, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Action } from '../../../../ui/types';
import type { ScreenCtx } from '../../kit';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { OFFICE_LABEL, PERSONAS } from '../../../../ui/fixtures/org/people';
import { MenuButton } from '../../../../ui/primitives/Menu';
import { ProgressBar, Spinner } from '../../../../ui/primitives/Progress';
import type { TimelineItemModel } from '../../../../ui/primitives/Timeline';
import { RecordScreen, type PhoneRecordTab } from '../../../../ui/record/RecordScreen';
import type { RecordSection } from '../../../../ui/record/model';
import { FieldsBody, HistoryBody, RecordExtras } from '../../../../ui/record/SectionBodies';
import { ParagraphComposer } from '../../../../ui/record/ParagraphComposer';
import { ReceiptDialog } from '../../../../ui/record/ReceiptDialog';
import { DocSummary } from '../../../../ui/work/DocSummary';
import { normLabel } from '../../../../ui/fixtures/work';
import { findLiveCase, visibleCases } from '../../store/cases';
import { P } from '../../paths';
import { docFieldsOf, draftOf, fieldsOf, mainDocument, pointsOf, recordOf, recordPathOf } from './adapters';
import { addParagraph, assignCase, askAssistant, decideProposal, improveDraft, pendingProposals, reopenCase, saveDraft, startPrimary, toggleCheck } from './actions';
import { assigneeItems } from './assignees';
import { CLOSED, historyAt } from './format';
import { openOriginal, openSource } from './keys';
import { kindOfWho } from './sheet';

const HISTORY_ICON = { flow: Workflow, ai: Sparkles, person: User, program: Bot, receipt: CircleCheck } as const;
const HISTORY_TONE = { flow: 'neutral', ai: 'pink', person: 'amber', program: 'green', receipt: 'green' } as const;

interface Fmt {
  b: boolean;
  i: boolean;
  l: boolean;
}

export function RecordPlace({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const w = ctx.copy.work.record;
  const [section, setSection] = ctx.ui<RecordSection>(`work.record.${id}.section`, 'documents');
  const [msg, setMsg] = ctx.ui<string>(`work.record.${id}.msg`, '');
  const [paragraph, setParagraph] = ctx.ui<string>(`work.record.${id}.paragraph`, '');
  const [fmt, setFmt] = ctx.ui<Fmt>(`work.record.${id}.fmt`, { b: false, i: false, l: false });
  const [tab, setTab] = ctx.ui<PhoneRecordTab>(`work.record.${id}.tab`, 'draft');
  const [receiptOpen, setReceiptOpen] = ctx.ui<boolean>(`work.record.${id}.receipt`, false);

  const c = visibleCases(ctx.state, ctx.persona).find((x) => x.id === id) ?? (ctx.can('view:overview') ? findLiveCase(ctx.state, id) : undefined);
  if (!c) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmptyState icon={FileText} title={w.notFoundTitle} action={<Button onClick={() => ctx.go(P.inbox())}>{w.backToList}</Button>}>{w.notFoundBody}</EmptyState>
      </div>
    );
  }

  const record = recordOf(c, ctx.copy);
  const receipts = record.receipts ?? [];
  const slots = draftOf(c)?.slots ?? [];
  const pending = pendingProposals(c);
  const job = ctx.job(`case.${c.id}.primary`);
  const improving = ctx.job(`case.${c.id}.improve`);
  const edit = (fn: () => void): Action => ctx.allow('edit:data', fn);
  const denied = ctx.deniedTitle('edit:data');
  const main = mainDocument(c);

  const start = edit(() => startPrimary(ctx, c));
  // Until the record is confirmed its main button is not the next step: it first asks for the confirmation.
  const waitsConfirm = c.status === 'da-confermare' && receipts.length === 0;
  const running = job?.status === 'running';

  /* What the person sees under the header: waiting for confirmation, a job in progress, a job that stopped. */
  let banner: ReactNode;
  if (running && job) {
    const total = ctx.copy.work.record.jobSteps[c.primaryAction.kind].length;
    banner = (
      <div className="shrink-0 border-b border-app-border bg-sky-500/[0.06] px-4 py-2.5">
        <ProgressBar value={job.progress} label={w.jobRunning(c.primaryAction.label, job.current ?? '', job.done.length + 1, total)} detail={`${Math.round(job.progress * 100)}%`} />
      </div>
    );
  } else if (job?.status === 'failed' && receipts.length === 0) {
    banner = (
      <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rose-500/30 bg-rose-500/[0.07] px-4 py-2 text-prose text-app-text">
        <CircleAlert size={15} className="shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">{w.jobFailed(pending)}</span>
        <Button onClick={start} title={denied}>{w.retry}</Button>
      </div>
    );
  } else if (c.status === 'da-confermare') {
    banner = (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/[0.08] px-4 py-2 text-prose text-app-text">
        <Hourglass size={15} className="shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <span className="min-w-0 flex-1"><strong className="font-semibold">{w.bannerConfirm}</strong> {w.bannerConfirmBody}{c.draft ? ` ${w.bannerConfirmDraft}` : ''}</span>
        <Button onClick={() => ctx.go(P.inbox(c.id))}>{w.goConfirm}</Button>
      </div>
    );
  } else if (c.status === CLOSED || c.status === 'in-attesa') {
    banner = (
      <div className="flex shrink-0 items-center gap-2 border-b border-app-border bg-app-inset px-4 py-2 text-prose text-app-text-secondary">
        {c.status === CLOSED ? <Lock size={15} className="shrink-0" aria-hidden="true" /> : <Hourglass size={15} className="shrink-0" aria-hidden="true" />}
        {c.status === CLOSED ? w.bannerClosed : w.bannerWaiting}
      </div>
    );
  }

  const primarySlot: ReactNode = running ? (
    <span role="status" className="inline-flex h-7 items-center gap-2 whitespace-nowrap px-2.5 text-prose text-app-text-secondary"><Spinner size={14} />{job?.current}</span>
  ) : c.status === CLOSED && receipts.length === 0 ? (
    <Button variant="primary" onClick={edit(() => reopenCase(ctx, c))} title={denied}>{w.reopen}</Button>
  ) : undefined;

  /* The left column's other sections. */
  const history: TimelineItemModel[] = c.history.map((e, i) => {
    const kind = receipts.some((r) => r.title === e.what) ? 'receipt' : kindOfWho(e.who, ctx.copy);
    return {
      id: `h-${i}`,
      at: historyAt(e.at),
      title: e.what,
      who: e.who,
      tone: HISTORY_TONE[kind],
      icon: HISTORY_ICON[kind],
      onOpen: e.doc && c.documents.some((d) => d.id === e.doc) ? () => openOriginal(ctx, c, e.doc!) : undefined,
    };
  }).reverse();
  const sectionBody: ReactNode = section === 'data' ? (
    <FieldsBody
      fields={fieldsOf(c)}
      copy={ctx.copy}
      onOpenField={(f) => ctx.go(P.recordOrigin(c.id, f))}
      onOpenSheet={() => ctx.go(P.recordSheet(c.id))}
    />
  ) : section === 'history' ? (
    <HistoryBody items={history} copy={ctx.copy} onOpenSheet={() => ctx.go(P.recordSheet(c.id))} />
  ) : undefined;

  const parcel = c.parcel ? w.parcelDetail(c.parcel.comune, c.parcel.foglio, c.parcel.particella, c.parcel.canale) : undefined;
  const extras = (
    <RecordExtras
      receipts={receipts}
      receiptsLabel={w.receipts}
      norms={(c.norms ?? []).map((n) => ({ id: n, label: normLabel(n) }))}
      parcel={parcel}
      copy={ctx.copy}
      onOpenReceipt={() => setReceiptOpen(true)}
      onOpenNorm={(n) => { const [item, article] = n.split('/'); ctx.go(P.knowledgeDoc(item, article)); }}
      onOpenParcel={() => ctx.go(P.parcel(c.id))}
    />
  );

  const assignItems = assigneeItems(ctx, c.org, c.assignee);
  const assignee = PERSONAS.find((p) => p.id === c.assignee);
  const assigneeOffice = assignee?.offices[0];
  const onAssign = (pid: string) => { const run = edit(() => assignCase(ctx, c, pid)); if (run) run(); };
  const headerActions = ctx.phone ? (
    <MenuButton
      iconOnly
      icon={MoreHorizontal}
      label={w.moreActions}
      items={[{ id: 'sheet', label: w.openSheet, icon: FileText }, { id: 'sep', label: '', separator: true }, ...assignItems.map((i) => ({ ...i, label: `${w.assignTo} ${i.label}` }))]}
      onSelect={(sel) => (sel === 'sheet' ? ctx.go(P.recordSheet(c.id)) : onAssign(sel))}
    />
  ) : (
    <>
      <Button onClick={() => ctx.go(P.recordSheet(c.id))}>{w.openSheet}</Button>
      <MenuButton label={w.assigneeShort(assigneeOffice ? OFFICE_LABEL[assigneeOffice] : assignee?.name ?? c.assignee)} icon={User} items={assignItems} onSelect={onAssign} disabled={!ctx.can('edit:data')} title={denied ?? w.assignee(assignee?.name ?? c.assignee)} align="right" className="max-w-[12rem]" />
    </>
  );

  const decide = (index: number, decision: 'accept' | 'discard') => {
    const slot = slots[index];
    if (!slot) return;
    const run = edit(() => decideProposal(ctx, c, slot, decision));
    if (run) run();
    else ctx.toast({ tone: 'warn', title: denied ?? '' });
  };

  const draftMain = c.draft ? undefined : (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <p className="px-5 pt-4 text-compact font-semibold uppercase tracking-[0.06em] text-app-text-tertiary">{w.summaryMain}</p>
      {main && <DocSummary points={pointsOf(main)} fields={docFieldsOf(c, main, ctx.copy)} page={0} copy={ctx.copy} onOpenPoint={(i) => openOriginal(ctx, c, main.id, main.summary[Number(i)]?.page)} onOpenField={(f) => ctx.go(P.recordOrigin(c.id, f))} wide />}
    </div>
  );

  return (
    <>
      <RecordScreen
        record={record}
        copy={ctx.copy}
        phone={ctx.phone}
        phoneTab={tab}
        onPhoneTabChange={setTab}
        section={section}
        onSectionChange={setSection}
        sectionBody={sectionBody}
        banner={banner}
        primarySlot={primarySlot}
        primaryVariant={receipts.length > 0 || waitsConfirm ? 'secondary' : 'primary'}
        primaryTitle={waitsConfirm ? denied ?? w.primaryWaits : receipts.length > 0 ? undefined : denied}
        onPrimary={receipts.length > 0 ? () => setReceiptOpen(true) : start}
        onSaveDraft={edit(() => saveDraft(ctx, c))}
        saveTitle={denied}
        headerActions={headerActions}
        onOpenDeadline={() => ctx.go(c.fields.some((f) => f.id === 'scadenza') ? P.recordOrigin(c.id, 'scadenza') : P.recordSheet(c.id))}
        onOpenStep={(step) => ctx.go(P.flowStep(c.flow, step))}
        onOpenDocument={(doc) => { if (!c.documents.find((d) => d.id === doc)?.draft) openOriginal(ctx, c, doc); }}
        onOpenRelated={(rid) => ctx.go(recordPathOf({ id: rid, org: c.org }))}
        onOpenSource={(s) => openSource(ctx, c, s)}
        onProposal={decide}
        tools={{
          bold: { pressed: fmt.b, onClick: () => setFmt((f) => ({ ...f, b: !f.b })) },
          italic: { pressed: fmt.i, onClick: () => setFmt((f) => ({ ...f, i: !f.i })) },
          list: { pressed: fmt.l, onClick: () => setFmt((f) => ({ ...f, l: !f.l })) },
          improve: improving?.status === 'running' ? false : edit(() => improveDraft(ctx, c)),
        }}
        docsExtra={extras}
        main={draftMain}
        draftFooter={c.draft ? (
          <ParagraphComposer
            value={paragraph}
            onChange={setParagraph}
            copy={ctx.copy}
            onAdd={edit(() => {
              const text = paragraph.trim();
              if (!text) {
                ctx.toast({ tone: 'warn', title: w.paragraphEmpty });
                return;
              }
              addParagraph(ctx, c, { text, bold: fmt.b || undefined, italic: fmt.i || undefined, bullet: fmt.l || undefined });
              setParagraph('');
              ctx.toast({ tone: 'ok', title: ctx.copy.work.toast.paragraphAdded });
            })}
          />
        ) : undefined}
        assist={{
          message: msg,
          onMessageChange: setMsg,
          onAsk: (q) => askAssistant(ctx, c, q),
          onToggleCheck: (cid) => toggleCheck(ctx, c, cid, record.assistant.checklist.find((x) => x.id === cid)?.done ?? false),
        }}
        onSend={() => { askAssistant(ctx, c, msg); setMsg(''); }}
      />
      {receiptOpen && receipts[0] && (
        <ReceiptDialog receipt={receipts[0]} copy={ctx.copy} onClose={() => setReceiptOpen(false)} onOpenSheet={() => { setReceiptOpen(false); ctx.go(P.recordSheet(c.id)); }} />
      )}
    </>
  );
}

