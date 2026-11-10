/**
 * n13: the collections of the knowledge base and the question box. The place
 * for `/conoscenza` and `/conoscenza/cerca/:q`. (allow-italian: quotes the Italian interface)
 */
import { useMemo } from 'react';
import { Lock } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { Permission } from '../../../../ui/fixtures/org/people';
import type { SourceModel } from '../../../../ui/types';
import { Button } from '../../../../ui/primitives/Button';
import { KeyValue, PanelHeading, PanelSection } from '../../../../ui/primitives/Panel';
import { CollectionsScreen } from '../../../../ui/knowledge/CollectionsScreen';
import { UploadForm } from '../../../../ui/knowledge/UploadForm';
import type { CollectionPanelModel, CollectionRowModel, PassageModel, RecentModel } from '../../../../ui/knowledge/model';
import { COLLECTIONS, PROCEDURES, STAFF_COUNTS, USAGE_ESTIMATES, type CollectionId } from '../../../../ui/fixtures/knowledge-more';
import { SUGGESTIONS } from '../../../../ui/fixtures/knowledge-more-answers';
import { P } from '../../paths';
import {
  allItems, answerQuestion, citingCases, citingFlows, citingProcedures, getItem, itemsInCollection, liveProcedure, procedureStatus, sourcePath, stamp,
} from './engine';
import { DOCS_INIT, DOCS_SLICE, PROCEDURES_SLICE, type DocsState, type ProceduresState } from './state';
import { openItemPath, reviewing } from './helpers';

const decode = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

export function CollectionsPlace({ ctx, q }: { ctx: ScreenCtx; q?: string }) {
  const copy = ctx.copy;
  const c = copy.knowledgeMore.collections;
  const [docs, setDocs] = ctx.slice<DocsState>(DOCS_SLICE, DOCS_INIT);
  const [procs] = ctx.slice<ProceduresState>(PROCEDURES_SLICE, {});
  const [sel, setSel] = ctx.ui<string>('kn.sel', 'procedure');
  const [draft, setDraft] = ctx.ui<string | null>('kn.ask', null);
  const [uploadOpen, setUploadOpen] = ctx.ui<boolean>('kn.upload.open', false);
  const [upTitle, setUpTitle] = ctx.ui<string>('kn.upload.title', '');
  const [upCollection, setUpCollection] = ctx.ui<string>('kn.upload.collection', 'regolamenti');
  const [upText, setUpText] = ctx.ui<string>('kn.upload.text', '');
  const [upError, setUpError] = ctx.ui<string>('kn.upload.error', '');

  const roleLocked = (id: CollectionId) => {
    const col = COLLECTIONS.find((x) => x.id === id);
    return !!col?.roles && !col.roles.includes(ctx.persona.role);
  };
  const toReview = reviewing(procs);
  /** What a control does when the person may not: say why, instead of nothing. */
  const denied = (perm: Permission) => () => ctx.toast({ tone: 'warn', title: ctx.deniedTitle(perm) ?? '' });
  const answer = useMemo(() => (q ? answerQuestion(q, docs, procs) : undefined), [q, docs, procs]);

  /* ---- the table ---- */
  const staffTotal = STAFF_COUNTS.reduce((n, s) => n + s.count, 0);
  const rows: CollectionRowModel[] = COLLECTIONS.map((col) => {
    const locked = roleLocked(col.id);
    const count = col.id === 'personale' ? String(staffTotal) : col.id === 'procedure' ? String(PROCEDURES.length) : String(itemsInCollection(docs, col.id).length);
    const state = locked
      ? { text: c.locked, tone: 'neutral' as const }
      : col.id === 'procedure' && toReview.length
        ? { text: c.toReview(toReview.length), tone: 'amber' as const }
        : { text: c.updated, tone: 'green' as const };
    return {
      id: col.id,
      label: col.label,
      count: locked ? '-' : count,
      viewers: col.viewers,
      source: col.id === 'personale' ? (docs.sharepoint ? c.sharepointLinked : c.sharepointToLink) : col.source,
      state,
      locked,
    };
  });

  /* ---- jobs ---- */
  const connect = ctx.allow('edit:structure', () => {
    ctx.startJob({
      id: 'kn-sharepoint',
      title: c.connectJob.title,
      steps: [{ label: c.connectJob.steps[0], ms: 900 }, { label: c.connectJob.steps[1], ms: 1100 }, { label: c.connectJob.steps[2], ms: 700 }],
      onDone: (ok) => {
        if (!ok) return;
        setDocs((d) => ({ ...d, sharepoint: true }));
        ctx.log(c.connectLog, 'structure');
        ctx.toast({ tone: 'ok', title: c.connectedToast, body: c.connectedBody });
      },
    });
  });
  const connectAction = (id: 'sync' | 'disconnect') => {
    if (id === 'sync') {
      ctx.startJob({
        id: 'kn-sharepoint',
        title: c.syncJob.title,
        steps: [{ label: c.syncJob.steps[0], ms: 800 }, { label: c.syncJob.steps[1], ms: 900 }, { label: c.syncJob.steps[2], ms: 500 }],
        onDone: (ok) => { if (ok) ctx.toast({ tone: 'ok', title: c.syncJob.done, body: c.syncJob.doneBody(staffTotal) }); },
      });
      return;
    }
    ctx.confirm({
      title: c.disconnectTitle,
      body: c.disconnectBody,
      confirmLabel: c.disconnectConfirm,
      tone: 'danger',
      onConfirm: () => {
        setDocs((d) => ({ ...d, sharepoint: false }));
        ctx.log(c.disconnectLog, 'structure');
        ctx.toast({ tone: 'info', title: c.disconnectedToast });
      },
    });
  };
  const syncNoticeBoard = ctx.allow('edit:data', () => {
    ctx.startJob({
      id: 'kn-albo',
      title: c.panel.syncJob.title,
      steps: [{ label: c.panel.syncJob.steps[0], ms: 900 }, { label: c.panel.syncJob.steps[1], ms: 800 }, { label: c.panel.syncJob.steps[2], ms: 500 }],
      onDone: (ok) => {
        if (!ok) return;
        setDocs((d) => ({ ...d, synced: ctx.now }));
        ctx.log(c.panel.syncLog, 'knowledge');
        ctx.toast({ tone: 'ok', title: c.panel.syncToast, body: c.panel.syncBody(itemsInCollection(docs, 'delibere').length) });
      },
    });
  });

  /* ---- upload ---- */
  const upJob = ctx.job('kn-upload');
  const submitUpload = ctx.allow('edit:data', () => {
    if (!upTitle.trim() || !upText.trim()) {
      ctx.toast({ tone: 'warn', title: c.uploadNeedText });
      return;
    }
    const collection = (COLLECTIONS.find((x) => x.id === upCollection)?.id ?? 'regolamenti') as CollectionId;
    const title = upTitle.trim();
    const text = upText.trim();
    const label = COLLECTIONS.find((x) => x.id === collection)?.label ?? '';
    setUpError('');
    ctx.startJob({
      id: 'kn-upload',
      title: c.uploadJob.title(title),
      steps: [
        { label: c.uploadJob.steps[0], ms: 700, fails: text.length < 40 },
        { label: c.uploadJob.steps[1], ms: 800 },
        { label: c.uploadJob.steps[2], ms: 700 },
      ],
      onDone: (ok) => {
        if (!ok) {
          setUpError(c.uploadFailed);
          ctx.toast({ tone: 'error', title: c.uploadFailedTitle, body: c.uploadFailed });
          return;
        }
        const id = `up-${Date.now().toString(36)}`;
        setDocs((d) => ({ ...d, uploads: [...d.uploads, { id, title, collection, text, by: ctx.persona.name, at: ctx.now }] }));
        setUpTitle('');
        setUpText('');
        setUploadOpen(false);
        setSel(collection);
        ctx.log(c.uploadedLog(title, label), 'knowledge', P.knowledgeDoc(id));
        ctx.toast({ tone: 'ok', title: c.uploadedToast(title), body: c.uploadedBody(label), action: { label: c.uploadedOpen, path: P.knowledgeDoc(id) } });
      },
    });
  });

  /* ---- the question box ---- */
  const ask = (question: string) => {
    if (!question) {
      ctx.toast({ tone: 'info', title: c.askEmpty });
      return;
    }
    setDraft(null);
    setDocs((d) => ({ ...d, questions: [{ q: question, at: ctx.now }, ...d.questions.filter((x) => x.q !== question)].slice(0, 20) }));
    ctx.log(c.askLog(question), 'knowledge', P.knowledgeSearch(question));
    ctx.go(P.knowledgeSearch(question));
  };
  const openSourceToken = (id: string | undefined) => {
    const path = sourcePath(id);
    if (path) ctx.go(path);
  };

  /* ---- recent and most cited ---- */
  const recent: RecentModel[] = [];
  for (const path of ctx.state.recent) {
    const m = /^\/conoscenza\/(doc|procedure|cerca)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) continue;
    if (q && path === P.knowledgeSearch(decode(q))) continue; // the question on show is not a way to open it again
    const id = decode(m[2]);
    if (m[1] === 'cerca') recent.push({ id: path, label: id, detail: c.recentQuestion, kind: 'question' });
    else if (m[1] === 'procedure') {
      const proc = PROCEDURES.find((p) => p.id === id);
      if (proc) recent.push({ id: path, label: proc.title, detail: c.recentProcedure, kind: 'procedure' });
    } else if (m[3] !== 'originale') {
      const item = getItem(docs, id);
      if (item) recent.push({ id: path, label: item.label, detail: item.subtitle ?? item.title, kind: 'doc' });
    }
    if (recent.length >= 5) break;
  }
  const mostCited = allItems(docs)
    .map((i) => ({ id: i.id, label: i.label, count: citingCases(i.id).length + citingProcedures(i.id).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5);

  /* ---- the panel ---- */
  const col = COLLECTIONS.find((x) => x.id === sel) ?? COLLECTIONS[0];
  const locked = roleLocked(col.id);
  const colItems = itemsInCollection(docs, col.id);
  const flowIds = new Set<string>();
  for (const i of colItems) for (const f of citingFlows(i)) flowIds.add(f.flowId);
  if (col.id === 'procedure') for (const p of PROCEDURES) if (p.flow) flowIds.add(p.flow);
  const panel: CollectionPanelModel = {
    tag: c.panel.tag,
    title: col.label,
    description: col.description,
    action: col.id === 'delibere'
      ? { label: c.panel.syncNow, token: 'sync' }
      : undefined,
    items: col.id === 'procedure'
      ? PROCEDURES.map((p) => {
        const st = procedureStatus(p, liveProcedure(procs, p.id));
        return { id: p.id, label: p.title, chip: st === 'da-rivedere' || st === 'modifiche' ? { text: c.panel.statusReview, tone: 'violet' as const } : st === 'in-collaudo' ? { text: c.panel.statusTest, tone: 'amber' as const } : undefined };
      })
      : colItems.map((i) => ({ id: i.id, label: i.label, chip: i.articles.some((a) => a.subject && !docs.pasted[`${i.id}/${a.id}`]) ? { text: c.panel.statusPending, tone: 'amber' as const } : undefined })),
    review: col.id === 'procedure' ? toReview.map((p) => ({ id: p.id, label: p.title })) : [],
    rules: c.panel.rulesRows.map((r) => ({ label: r.label, value: r.value, action: r.action })),
    usage: [
      { label: c.panel.flows, value: String(flowIds.size), action: 'flows' },
      { label: c.panel.questions, value: c.panel.questionsValue(USAGE_ESTIMATES.questionsPerMonth), estimate: true },
      { label: c.panel.mcp, value: c.panel.mcpValue(USAGE_ESTIMATES.mcpPeople, USAGE_ESTIMATES.people), estimate: true },
    ],
  };
  const panelAction = (token: string) => {
    if (token === 'sync') (syncNoticeBoard || denied('edit:data'))();
    else if (token === 'log') ctx.go(P.settings('registro'));
    else if (token === 'where') ctx.go(P.settings('dove-gira'));
    else if (token === 'flows') ctx.go(P.flows());
  };

  const requested = !!docs.requested[col.id];
  const requestAccess = () => {
    setDocs((d) => ({ ...d, requested: { ...d.requested, [col.id]: true } }));
    ctx.log(c.lockedPanel.requestLog(col.label), 'permission');
    ctx.notify({ title: c.lockedPanel.requestNotify(col.label), body: ctx.persona.name, path: P.knowledge(), tone: 'warn', to: ['direzione', 'attilio'] });
    ctx.toast({ tone: 'ok', title: c.lockedPanel.requestToast, body: c.lockedPanel.requestBody });
  };
  const lockedNode = locked ? (
    <>
      <PanelHeading tag={c.locked} tagIcon={Lock} title={col.label}>{c.lockedPanel.body(col.viewers)}</PanelHeading>
      <PanelSection>
        {requested
          ? <p className="text-prose text-app-text-secondary">{c.lockedPanel.requested}</p>
          : <Button variant="primary" onClick={requestAccess}>{c.lockedPanel.request}</Button>}
      </PanelSection>
    </>
  ) : col.id === 'personale' ? (
    <>
      <PanelHeading tag={c.panel.tag} title={col.label}>{col.description}</PanelHeading>
      <PanelSection label={c.lockedPanel.staffTitle}>
        {STAFF_COUNTS.map((s) => <KeyValue key={s.id} label={s.label} value={<span className="font-semibold">{s.count}</span>} />)}
        <KeyValue label={c.lockedPanel.staffTotal} value={<span className="font-semibold">{staffTotal}</span>} />
        <p className="mt-1.5 text-mini text-app-text-tertiary">{c.lockedPanel.staffNote}</p>
      </PanelSection>
      <PanelSection>
        {docs.sharepoint
          ? <p className="text-prose text-app-text-secondary">{c.connectedBody}</p>
          : <Button variant="primary" onClick={connect} title={ctx.deniedTitle('edit:structure')}>{c.connect}</Button>}
      </PanelSection>
    </>
  ) : undefined;

  const jobs = ['kn-sharepoint', 'kn-albo']
    .map((id) => ctx.job(id))
    .filter((j): j is NonNullable<typeof j> => !!j && j.status === 'running')
    .map((j) => ({ id: j.id, label: `${j.title}${j.current ? ` · ${j.current}` : ''}`, progress: j.progress }));

  const lastSync = docs.synced ? c.panel.lastSync(stamp(docs.synced)) : undefined;
  if (lastSync && col.id === 'delibere') panel.description = `${col.description} ${lastSync}`;

  return (
    <CollectionsScreen
      copy={copy}
      phone={ctx.phone}
      count={COLLECTIONS.length}
      jobs={jobs}
      question={draft ?? q ?? ''}
      onQuestionChange={setDraft}
      onAsk={ask}
      suggestions={SUGGESTIONS}
      answer={answer}
      onClearAnswer={() => { setDraft(null); ctx.go(P.knowledge()); }}
      onOpenSource={(s: SourceModel) => openSourceToken(s.id)}
      onOpenPassage={(p: PassageModel) => openSourceToken(p.sourceId)}
      rows={rows}
      selectedId={col.id}
      onSelectRow={setSel}
      panel={panel}
      lockedPanel={lockedNode}
      onPanelAction={panelAction}
      onOpenPanelItem={(id) => ctx.go(openItemPath(id))}
      onOpenReview={(id) => ctx.go(P.procedure(id))}
      recent={recent}
      onOpenRecent={(r) => ctx.go(r.id)}
      mostCited={mostCited}
      onOpenCited={(id) => ctx.go(P.knowledgeDoc(id))}
      onMap={() => ctx.go(P.knowledgeMap())}
      onConnect={connect}
      onConnectAction={connectAction}
      connectTitle={ctx.deniedTitle('edit:structure')}
      connected={docs.sharepoint}
      onUpload={ctx.allow('edit:data', () => setUploadOpen(!uploadOpen))}
      uploadTitle={ctx.deniedTitle('edit:data')}
      uploadSlot={uploadOpen ? (
        <UploadForm
          copy={copy}
          title={upTitle}
          onTitle={setUpTitle}
          collection={upCollection}
          onCollection={setUpCollection}
          collections={COLLECTIONS.filter((x) => !x.roles && x.id !== 'procedure').map((x) => ({ value: x.id, label: x.label }))}
          text={upText}
          onText={setUpText}
          onSubmit={submitUpload || denied('edit:data')}
          onCancel={() => { setUploadOpen(false); setUpError(''); }}
          progress={upJob?.status === 'running' ? { value: upJob.progress, label: `${upJob.title} · ${upJob.current ?? ''}` } : undefined}
          error={upError}
        />
      ) : undefined}
    />
  );
}
