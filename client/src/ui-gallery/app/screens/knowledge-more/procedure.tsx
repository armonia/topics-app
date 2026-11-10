/**
 * x04: a procedure the AI wrote, to approve. The place for
 * `/conoscenza/procedure/:id`.
 */
import { BackButton } from '../../../../ui/shell/PaneHeader';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { KeyValue } from '../../../../ui/primitives/Panel';
import { ProcedureScreen, type ProcedureActions } from '../../../../ui/knowledge/ProcedureScreen';
import type { ProcedureModel, ProcedureStepModel } from '../../../../ui/knowledge/model';
import type { SourceModel } from '../../../../ui/types';
import { PROCEDURES, type ProcedureSeed } from '../../../../ui/fixtures/knowledge-more';
import type { ProcedureStepSeed } from '../../../../ui/fixtures/knowledge-more-procedures';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { CASES } from '../../../../ui/fixtures/org/cases';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { day, liveProcedure, normLabel, normToken, procedureStatus, procedureSteps, sourcePath, stamp } from './engine';
import {
  DOCS_INIT, DOCS_SLICE, PROCEDURES_SLICE, type DocsState, type ProcedureLive, type ProcedureLiveStatus, type ProceduresState,
} from './state';

const STATUS_TONE: Record<ProcedureLiveStatus, 'amber' | 'green' | 'neutral'> = {
  'da-rivedere': 'amber', 'in-collaudo': 'amber', approvata: 'green', modifiche: 'amber', scartata: 'neutral',
};

export function ProcedurePlace({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const copy = ctx.copy;
  const p = copy.knowledgeMore.procedure;
  const seed = PROCEDURES.find((x) => x.id === id);
  const [docs] = ctx.slice<DocsState>(DOCS_SLICE, DOCS_INIT);
  const [procs, setProcs] = ctx.slice<ProceduresState>(PROCEDURES_SLICE, {});
  const [draft, setDraft] = ctx.ui<ProcedureStepSeed[] | null>(`kn.proc.${id}.draft`, null);
  const [changesOpen, setChangesOpen] = ctx.ui<boolean>(`kn.proc.${id}.changes`, false);
  const [changesText, setChangesText] = ctx.ui<string>(`kn.proc.${id}.changesText`, '');
  const [commentText, setCommentText] = ctx.ui<string>(`kn.proc.${id}.comment`, '');

  if (!seed) {
    return (
      <EmptyState title={p.notFoundTitle}>
        {p.notFoundBody}
        <div className="mt-3"><Button variant="primary" onClick={() => ctx.go(P.knowledge())}>{p.backToList}</Button></div>
      </EmptyState>
    );
  }

  const live = liveProcedure(procs, id);
  const status = procedureStatus(seed, live);
  const steps = procedureSteps(seed, live);
  const set = (fn: (l: ProcedureLive) => ProcedureLive) => setProcs((all) => ({ ...all, [id]: fn(all[id] ?? { comments: [], versions: [] }) }));
  const me = ctx.persona.monogram;
  const path = P.procedure(id);

  /* ---- sources of a step ---- */
  const caseOfKind = (kind: ProcedureSeed['caseKind']) => CASES.find((c) => c.kind === kind);
  const stepSource = (s: ProcedureStepSeed): { label: string; id?: string } => {
    if (s.norm) return { label: normLabel(docs, s.norm), id: normToken(s.norm) };
    const c = (s.caseKind ? caseOfKind(s.caseKind) : undefined) ?? caseOfKind(seed.caseKind);
    return c ? { label: `${c.id} · ${c.title}`, id: `c:${c.id}` } : { label: p.stepNoSource };
  };
  const toModelStep = (s: ProcedureStepSeed): ProcedureStepModel => ({ id: s.id, text: s.text, source: stepSource(s), added: s.added });

  /* ---- facts, intro, sources ---- */
  const nCases = CASES.filter((c) => c.kind === seed.caseKind).length;
  const written = day(seed.writtenAt);
  const introduction = seed.fixedCases ? p.introFixed(seed.fixedCases) : p.intro(nCases, written);
  const flow = seed.flow ? FLOWS.find((f) => f.id === seed.flow) : undefined;
  const firstCase = caseOfKind(seed.caseKind);
  const sources = [
    ...(seed.fixedCases
      ? [{ label: p.sourceClosed(seed.fixedCases), value: p.sourceClosedWhen }]
      : [{ label: p.sourceCases(nCases), value: p.sourceOpenCase, id: firstCase ? `c:${firstCase.id}` : undefined }]),
    ...seed.base.map((b) => ({ label: b.label, value: b.norm ? p.sourceOpenNorm : p.sourceToLink, id: b.norm ? normToken(b.norm) : undefined })),
    ...(seed.alsoRead ? [{ label: seed.alsoRead, value: p.sourceAlsoRead }] : []),
  ];

  const versions = [
    { id: 'v0', label: 'v1', detail: p.versionAi(day(seed.writtenAt)), current: live.versions.length === 0 },
    ...live.versions.map((v, i) => ({
      id: v.id,
      label: `v${i + 2}`,
      detail: v.kind === 'approved' ? p.versionApproved(v.who, stamp(v.at)) : v.kind === 'rewritten' ? p.versionRewritten(stamp(v.at)) : p.versionEdited(v.who, stamp(v.at)),
      current: i === live.versions.length - 1,
    })),
  ];

  const baseNote = (() => {
    if (status === 'approvata') return p.noteApproved(live.approvedBy ?? seed.reviewer, live.approvedAt ? stamp(live.approvedAt) : day(seed.writtenAt));
    if (status === 'in-collaudo') return p.noteTest(seed.fixedCases ?? 0);
    if (status === 'modifiche') return p.noteChanges; // allow-italian: fixture data, shown as written
    if (status === 'scartata') return p.noteDiscarded; // allow-italian: fixture data, shown as written
    return p.noteReview(seed.reviewer);
  })();

  const model: ProcedureModel = {
    id,
    crumbs: [{ label: copy.knowledge.root }, { label: p.root }, { label: seed.title }],
    title: seed.title,
    status: { text: p.statuses[status], tone: STATUS_TONE[status] },
    note: baseNote,
    intro: introduction,
    facts: [
      { label: p.labels.who, value: seed.who },
      { label: p.labels.time, value: seed.timing },
      { label: p.labels.programs, value: seed.programs.join(', ') },
      { label: p.labels.base, value: seed.base.map((b) => b.label).join(' · ') },
    ],
    steps: steps.map(toModelStep),
    mistakes: seed.mistakes,
    panel: {
      tag: p.panelHeading[status],
      tagTone: STATUS_TONE[status],
      title: p.panelWho(status === 'approvata' ? seed.who : seed.reviewer, status),
      description: p.panelDescription[status],
    },
    sources,
    comments: [...seed.comments.map((c, i) => ({ id: `s${i}`, who: c.who, text: c.text, at: day(c.at) })), ...live.comments.map((c) => ({ id: c.id, who: c.who, text: c.text, at: stamp(c.at) }))],
    versions,
  };

  /* ---- what the person may do ---- */
  const denyApprove = ctx.deniedTitle('approve');
  const approve = ctx.allow('approve', () => ctx.confirm({
    title: p.approveTitle,
    body: p.approveBody(seed.title),
    confirmLabel: p.approveConfirm,
    onConfirm: () => {
      set((l) => ({ ...l, status: 'approvata', approvedBy: ctx.persona.name, approvedAt: ctx.now, versions: [...l.versions, { id: `a${l.versions.length}`, kind: 'approved', who: ctx.persona.name, at: ctx.now }] }));
      ctx.log(p.approvedLog(seed.title), 'knowledge', path);
      ctx.notify({ title: p.approveNotify(seed.title), body: p.approvedBody, path, tone: 'ok' });
      ctx.toast({ tone: 'ok', title: p.approvedToast(seed.title), body: p.approvedBody, action: { label: p.approvedOpen, path: P.knowledge() } });
    },
  }));
  const startChanges = ctx.allow('approve', () => setChangesOpen(!changesOpen));
  const sendChanges = () => {
    const text = changesText.trim();
    if (!text) {
      ctx.toast({ tone: 'warn', title: p.changesEmpty });
      return;
    }
    set((l) => ({ ...l, status: 'modifiche', comments: [...l.comments, { id: `c${l.comments.length + 1}`, who: me, text, at: ctx.now }] }));
    setChangesText('');
    setChangesOpen(false);
    ctx.log(p.changesLog(seed.title), 'knowledge', path);
    ctx.notify({ title: p.changesNotify(seed.title), body: text, path, tone: 'warn' });
    ctx.toast({ tone: 'info', title: p.changesToast });
  };
  const rewrite = ctx.allow('edit:data', () => {
    const last = [...live.comments].reverse()[0]?.text ?? '';
    ctx.startJob({
      id: `kn-rewrite-${id}`,
      title: p.rewriteJob.title,
      steps: [{ label: p.rewriteJob.steps[0], ms: 900 }, { label: p.rewriteJob.steps[1], ms: 1100 }, { label: p.rewriteJob.steps[2], ms: 700 }],
      onDone: (ok) => {
        if (!ok) return;
        set((l) => ({
          ...l,
          status: 'da-rivedere',
          steps: [...(l.steps ?? seed.steps), { id: `r${(l.steps ?? seed.steps).length + 1}`, text: p.rewrittenStep(last), added: true }],
          versions: [...l.versions, { id: `w${l.versions.length}`, kind: 'rewritten', who: p.aiName, at: ctx.now }],
        }));
        ctx.log(p.rewrittenLog(seed.title), 'knowledge', path);
        ctx.toast({ tone: 'ok', title: p.rewriteToast });
      },
    });
  });
  const discard = ctx.allow('approve', () => ctx.confirm({
    title: p.discardTitle,
    body: p.discardBody,
    confirmLabel: p.discardConfirm,
    tone: 'danger',
    onConfirm: () => {
      set((l) => ({ ...l, status: 'scartata' }));
      ctx.log(p.discardLog(seed.title), 'knowledge', path);
      ctx.toast({ tone: 'info', title: p.discardToast });
    },
  }));
  const restore = ctx.allow('approve', () => {
    set((l) => ({ ...l, status: undefined }));
    ctx.log(p.restoreLog(seed.title), 'knowledge', path);
    ctx.toast({ tone: 'ok', title: p.restoredToast });
  });
  const edit = ctx.allow('edit:structure', () => setDraft(steps.map((s) => ({ ...s }))));

  const actions: ProcedureActions = { approveTitle: denyApprove };
  if (status === 'da-rivedere' || status === 'modifiche') {
    actions.approve = approve;
    actions.requestChanges = startChanges;
    actions.discard = discard;
    actions.edit = edit;
    if (status === 'modifiche') actions.rewrite = rewrite;
  } else if (status === 'in-collaudo') {
    actions.openTest = () => ctx.go(P.testAll());
    actions.discard = discard;
    actions.edit = edit;
  } else if (status === 'approvata') {
    actions.edit = edit;
    actions.discard = discard;
  } else {
    actions.restore = restore;
  }
  if (status === 'modifiche') delete actions.approve;

  /* ---- editing ---- */
  const saveEdit = () => {
    const cleaned = (draft ?? []).filter((s) => s.text.trim()).map((s) => ({ ...s, text: s.text.trim() }));
    if (!cleaned.length) {
      ctx.toast({ tone: 'warn', title: p.editNeedStep });
      return;
    }
    set((l) => ({ ...l, steps: cleaned, versions: [...l.versions, { id: `e${l.versions.length}`, kind: 'edited', who: ctx.persona.name, at: ctx.now }] }));
    setDraft(null);
    ctx.log(p.savedLog(seed.title), 'knowledge', path);
    ctx.toast({ tone: 'ok', title: p.savedToast });
  };

  /* ---- comments ---- */
  const sendComment = ctx.allow('edit:data', () => {
    const text = commentText.trim();
    if (!text) {
      ctx.toast({ tone: 'warn', title: p.commentEmpty });
      return;
    }
    set((l) => ({ ...l, comments: [...l.comments, { id: `c${l.comments.length + 1}`, who: me, text, at: ctx.now }] }));
    setCommentText('');
    ctx.log(p.commentLog(seed.title), 'knowledge', path);
    ctx.toast({ tone: 'ok', title: p.commentSent });
  });

  /* ---- after the approval ---- */
  const createFlow = ctx.allow('edit:structure', () => ctx.startJob({
    id: `kn-flow-${id}`,
    title: p.afterFlowJob.title,
    steps: [{ label: p.afterFlowJob.steps[0], ms: 900 }, { label: p.afterFlowJob.steps[1], ms: 900 }],
    onDone: (ok) => {
      if (!ok) return;
      ctx.log(p.afterFlowLog(seed.title), 'structure', P.flowNew());
      ctx.toast({ tone: 'ok', title: p.afterFlowToast, body: p.afterFlowBody, action: { label: p.afterFlowOpen, path: P.flowNew() } });
    },
  }));
  const flowJob = ctx.job(`kn-flow-${id}`);
  const afterSlot = (
    <>
      <KeyValue
        label={p.afterFlow}
        value={flow ? (
          <Button size="sm" variant="ghost" onClick={() => ctx.go(P.flow(flow.id))}>{p.afterFlowOpenName(flow.name)}</Button>
        ) : flowJob?.status === 'running' ? <span className="text-compact text-app-text-tertiary">{flowJob.current}</span> : (
          <Button size="sm" variant="ghost" onClick={createFlow} title={ctx.deniedTitle('edit:structure')}>{p.afterFlowCreate}</Button>
        )}
      />
      <KeyValue label={p.afterReview} value={<span className="font-semibold">{p.afterReviewValue}</span>} />
      <KeyValue label={p.afterRead} value={<span className="font-semibold">{p.afterReadValue(status === 'approvata')}</span>} />
    </>
  );

  const openSource = (s: SourceModel) => {
    const to = sourcePath(s.id);
    if (to) ctx.go(to);
  };

  return (
    <ProcedureScreen
      copy={copy}
      phone={ctx.phone}
      model={model}
      actions={actions}
      backSlot={<BackButton label={copy.knowledge.root} onClick={() => ctx.go(P.knowledge())} copy={copy} />}
      editing={draft !== null}
      draftSteps={(draft ?? []).map((s) => ({ id: s.id, text: s.text }))}
      onEditChange={(sid, text) => setDraft((d) => (d ?? []).map((s) => (s.id === sid ? { ...s, text } : s)))}
      onEditAdd={() => setDraft((d) => [...(d ?? []), { id: `u${(d ?? []).length + 1}-${(d ?? []).reduce((n, s) => n + s.id.length, 0)}`, text: '', added: true }])}
      onEditRemove={(sid) => setDraft((d) => (d ?? []).filter((s) => s.id !== sid))}
      onEditMove={(sid, dir) => setDraft((d) => {
        const list = [...(d ?? [])];
        const i = list.findIndex((s) => s.id === sid);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return list;
        [list[i], list[j]] = [list[j], list[i]];
        return list;
      })}
      onEditSave={saveEdit}
      onEditCancel={() => setDraft(null)}
      changesOpen={changesOpen}
      changesDraft={changesText}
      onChangesDraft={setChangesText}
      onChangesSend={sendChanges}
      onChangesClose={() => setChangesOpen(false)}
      commentDraft={commentText}
      onCommentDraft={setCommentText}
      onCommentSend={sendComment || (() => ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:data') ?? '' }))}
      onOpenSource={openSource}
      afterSlot={afterSlot}
    />
  );
}
