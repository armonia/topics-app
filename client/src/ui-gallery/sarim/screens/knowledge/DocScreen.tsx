/**
 * sarim-doc: one document or rule of «Conoscenza», split in its parts (articles, (allow-italian: quotes the Italian interface)
 * paragraphs, steps of a procedure). Its text, its versions and the places
 * that use it are three pages with their own address, chosen in the strip
 * under the title. On the text page the parts are in the middle, each with
 * its official words when there are some, what they mean for the work, what
 * a step rests on and what the agents check, and a question box that answers
 * from this document first; on the right the facts, the checks with the flow
 * step that applies each, and who cites the part in focus. A procedure
 * written by an agent waits for its approver:
 * approving it (`approve`) or asking the agent for changes (`edit:data`)
 * leaves a line in the log, a notification and a new version.
 */
import { useEffect } from 'react';
import { CircleCheck, ExternalLink, GitCompareArrows, Library, PenLine, Sparkles, TriangleAlert, Workflow } from 'lucide-react';
import clsx from 'clsx';
import { AnswerCard } from '../../../../ui/knowledge/AnswerCard';
import { AskBox } from '../../../../ui/knowledge/AskBox';
import { KnowledgeScreen } from '../../../../ui/knowledge/KnowledgeScreen';
import { PartCard, type PartCardModel } from '../../../../ui/knowledge/PartCard';
import type { ArticleModel, KnowledgeModel, KnowledgeTab } from '../../../../ui/knowledge/model';
import { Button } from '../../../../ui/primitives/Button';
import { Card } from '../../../../ui/primitives/Card';
import { Chip } from '../../../../ui/primitives/Chip';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { TextArea } from '../../../../ui/primitives/Field';
import { BackButton } from '../../../../ui/shell/PaneHeader';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import { SubNav } from '../../../../ui/shell/SubNav';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import { knowledgeDocById, world } from '../../world';
import type { KnowledgeDoc } from '../../../../ui/fixtures/sarim-org/knowledge';
import type { ScreenCtx } from '../../../app/kit';
import { liveContracts } from '../../model/live';
import { opsFlowById } from '../../model/flows';
import { nameOf } from '../../model/words';
import { orgCrumbs } from '../../crumbs';
import { SP, type DocPage } from '../../paths';
import { KnowledgeNav } from './KnowledgeNav';
import { isCompanyDoc } from './collections';
import {
  ask, askCopy, citedCount, hostOf, KNOWLEDGE_INITIAL, KNOWLEDGE_SLICE, liveDoc, openExternal, recordQuestion, refLabel, refPath, suggestionsFor,
  usageOf, usagePath, usedByPart, type KnowledgeSlice,
} from './engine';
import { PAGE_GUTTER, READING_COLUMN } from '../../../../ui/shell/layout';

/** The nearest box that scrolls, so a part asked for in the address comes into view without moving the page. */
function scrollBox(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return undefined;
}

/** The page of a document each strip entry opens, and the tab of the shared screen it draws. */
export type DocPageId = 'text' | DocPage;
const TAB_OF: Record<DocPageId, KnowledgeTab> = { text: 'text', versions: 'versions', usage: 'usedBy' };

export function DocScreen({ ctx, docId, partId, page = 'text' }: { ctx: ScreenCtx; docId: string; partId?: string; page?: DocPageId }) {
  const copy = ctx.copy;
  const k = copy.sarimData.knowledge;
  const d = k.doc;
  const [slice, setSlice] = ctx.slice<KnowledgeSlice>(KNOWLEDGE_SLICE, KNOWLEDGE_INITIAL);
  const [input, setInput] = ctx.ui<string>(`sarim.k.input.${docId}`, '');
  const [asked, setAsked] = ctx.ui<string | null>(`sarim.k.ask.${docId}`, null);
  const [changesOpen, setChangesOpen] = ctx.ui<boolean>(`sarim.k.changes.open.${docId}`, false);
  const [note, setNote] = ctx.ui<string>(`sarim.k.changes.note.${docId}`, '');
  const [noteError, setNoteError] = ctx.ui<string>(`sarim.k.changes.error.${docId}`, '');
  const base = knowledgeDocById(docId);
  const focusId = base && partId && base.parts.some((p) => p.id === partId) ? partId : undefined;

  useEffect(() => {
    if (!focusId || page !== 'text') return;
    const el = document.querySelector<HTMLElement>(`[data-part="${CSS.escape(focusId)}"]`);
    const box = el ? scrollBox(el) : undefined;
    if (el && box) box.scrollTo({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 16 });
  }, [docId, focusId, page]);

  const company = base ? isCompanyDoc(base.collection) : true;
  const section = company ? 'documents' : 'rules';
  const listPath = company ? SP.documents() : SP.rules();
  /* on the desk the crumb of the list already leads back; the arrow is for the phone, which shows only the last crumb */
  const back = ctx.phone ? <BackButton label={copy.sarimData.section[section]} onClick={() => ctx.go(listPath)} copy={copy} /> : undefined;

  if (!base) {
    const empty: KnowledgeModel = {
      crumbs: orgCrumbs(ctx, [{ label: k.title, to: SP.knowledge() }, { label: copy.sarimData.section[section], to: listPath }, { label: docId }]),
      status: { text: '', tone: 'neutral' },
      collections: [],
      selectedId: '',
      title: docId,
      articleTabs: [],
      articles: [],
      panel: { tag: '', title: '', description: '', factsLabel: '', facts: [], rulesLabel: '', rules: [], changeLabel: '', changeText: '' },
    };
    return (
      <KnowledgeScreen doc={empty} copy={copy} loaded={false} phone={ctx.phone} backSlot={back} hideTree belowHeader={<KnowledgeNav ctx={ctx} active={section} />}>
        <EmptyState title={d.notFound.title}>
          {d.notFound.body}
          <div className="mt-3"><Button variant="primary" onClick={() => ctx.go(SP.documents())}>{d.notFound.back}</Button></div>
        </EmptyState>
      </KnowledgeScreen>
    );
  }

  const live = liveDoc(base, slice, copy);
  const doc: KnowledgeDoc = live.doc;
  const proc = doc.procedure;
  const contracts = liveContracts(ctx.state);
  const boxCopy = askCopy(copy, k.ask.placeholderDoc(doc.label));
  const answer = asked ? ask(asked, [live], contracts, copy, doc.id) : undefined;
  const fullAnswer = asked && answer?.status === 'none' ? ask(asked, world().knowledge.docs.map((x) => liveDoc(x, slice, copy)), contracts, copy, doc.id) : answer;
  const path = SP.knowledgeDoc(doc.id);
  const totalCited = doc.parts.reduce((n, p) => n + citedCount(doc, p), 0);
  const focusPart = (id: string) => ctx.go(id === focusId ? path : SP.knowledgeDoc(doc.id, id));

  /* ---- the question box, this document first ---- */
  const run = (question: string) => {
    if (!question) {
      ctx.toast({ tone: 'info', title: k.ask.empty });
      return;
    }
    setInput(question);
    setAsked(question);
    recordQuestion(ctx, question, doc);
  };

  /* ---- approving a procedure ---- */
  const flowNames = proc ? proc.flows.map((f) => opsFlowById(f)?.name ?? f).join(', ') : '';
  const latestLabel = live.versions.find((v) => v.id === live.latest)?.label ?? live.latest;
  const mayApprove = !!proc && ctx.can('approve') && (ctx.persona.id === proc.approver || ctx.persona.role === world().people.managerRole);
  const approveTitle = !proc ? undefined : !ctx.can('approve') ? ctx.deniedTitle('approve') : !mayApprove ? k.approve.onlyApprover(nameOf(proc.approver)) : undefined;
  const approve = mayApprove ? () => ctx.confirm({
    title: k.approve.title(doc.label),
    body: k.approve.body(flowNames),
    confirmLabel: k.approve.confirm,
    onConfirm: () => {
      setSlice((s) => ({ ...s, approved: { ...s.approved, [doc.id]: { at: ctx.now, by: ctx.persona.id, version: live.latest } } }));
      ctx.log(k.approve.log(doc.label, latestLabel), 'knowledge', path);
      ctx.toast({ tone: 'ok', title: k.approve.toast, body: k.approve.notifyBody(ctx.persona.name), action: { label: copy.sarimData.common.open, path } });
      ctx.notify({ title: k.approve.notifyTitle(doc.label), body: k.approve.notifyBody(ctx.persona.name), path, tone: 'ok' });
    },
  }) : false;

  /* ---- asking the agent for changes ---- */
  const jobId = `sarim-k-rewrite-${doc.id}`;
  const agentBusy = ctx.job(jobId)?.status === 'running';
  const openChanges = ctx.allow('edit:data', () => {
    setNoteError('');
    setChangesOpen(true);
  });
  const closeChanges = () => {
    setChangesOpen(false);
    setNoteError('');
  };
  const sendChanges = () => {
    const text = note.trim();
    if (!text) {
      setNoteError(k.changes.required);
      return;
    }
    if (!proc) return;
    const n = live.versions.length + 1;
    const approver = proc.approver;
    closeChanges();
    setNote('');
    ctx.startJob({
      id: jobId,
      title: k.changes.job(doc.label),
      steps: [
        { label: k.changes.steps.reading, ms: 900 },
        { label: k.changes.steps.writing, ms: 1200 },
        { label: k.changes.steps.checking, ms: 800 },
      ],
      onDone: (ok) => {
        if (!ok) return;
        setSlice((s) => ({ ...s, rewrites: { ...s.rewrites, [doc.id]: [...(s.rewrites[doc.id] ?? []), { n, at: ctx.now, by: ctx.persona.id, note: text }] } }));
        ctx.log(k.changes.log(doc.label, text), 'knowledge', path);
        ctx.toast({ tone: 'ok', title: k.changes.toast, body: k.changes.versionLabel(n), action: { label: copy.sarimData.common.open, path } });
        ctx.notify({ title: k.changes.notifyTitle(doc.label), body: k.changes.versionDetail(nameOf(proc.writtenBy), text), path, tone: 'info', to: [approver] });
      },
    });
  };

  /* ---- the panel ---- */
  const facts: KnowledgeModel['panel']['facts'] = [];
  if (proc) {
    facts.push({ label: d.procedure.writtenBy, value: nameOf(proc.writtenBy) });
    facts.push({ label: d.procedure.writtenAt, value: formatDay(proc.writtenAt) });
    facts.push({ label: d.procedure.state, value: live.status.text, pending: live.draft });
    facts.push({ label: d.procedure.approver, value: nameOf(proc.approver), action: `person:${proc.approver}` });
    if (proc.approvedAt) facts.push({ label: d.procedure.approvedAt, value: formatDay(proc.approvedAt) });
    if (proc.flows[0]) facts.push({ label: d.procedure.flows, value: flowNames, action: `flow:${proc.flows[0]}` });
    facts.push({ label: d.procedure.programs, value: proc.programs.join(', ') });
    facts.push({ label: d.procedure.time, value: proc.time });
    facts.push({ label: d.procedure.basedOn, value: proc.basedOn });
  } else {
    facts.push({ label: d.issuer, value: doc.issuer });
    for (const f of doc.facts) facts.push({ label: f.label, value: f.value });
    if (doc.url) facts.push({ label: d.official, value: doc.host ?? hostOf(doc.url), action: 'official' });
    if (doc.textUrl) facts.push({ label: d.quotesFrom, value: hostOf(doc.textUrl), action: 'text' });
  }
  facts.push({ label: d.parts, value: k.home.parts(doc.parts.length) });

  const rules: KnowledgeModel['panel']['rules'] = [];
  const seen = new Set<string>();
  for (const part of doc.parts) {
    for (const c of part.checks ?? []) {
      if (seen.has(c.label)) continue;
      seen.add(c.label);
      const flow = c.flow ? opsFlowById(c.flow) : undefined;
      const stepAt = flow && c.step ? flow.steps.findIndex((s) => s.id === c.step) : -1;
      const step = flow && stepAt >= 0 ? flow.steps[stepAt] : undefined;
      /* the flow by the words before its arrow and the step by its number: the step's whole sentence wrapped over four lines in the narrow panel, and it reads in full on the step it opens */
      const flowShort = flow ? flow.name.split(' → ')[0] : '';
      rules.push({
        label: c.label,
        value: step ? copy.sarimData.common.step(flowShort, stepAt + 1) : flow?.name ?? part.short,
        action: flow ? (step ? `step:${flow.id}/${step.id}` : `flow:${flow.id}`) : `part:${part.id}`,
      });
    }
  }

  const articles: ArticleModel[] = doc.parts.map((p) => ({
    id: p.id,
    heading: p.heading,
    text: [p.summary],
    usedBy: usedByPart(doc, p, ctx.state, copy),
  }));
  const model: KnowledgeModel = {
    crumbs: orgCrumbs(ctx, [{ label: k.title, to: SP.knowledge() }, { label: copy.sarimData.section[section], to: listPath }, ...(page === 'text' ? [{ label: doc.label }] : [{ label: doc.label, to: path }, { label: d.pages[page] }])]),
    status: live.status,
    collections: [],
    selectedId: doc.id,
    title: doc.title,
    subtitle: doc.subtitle,
    articleTabs: doc.parts.map((p) => ({ id: p.id, label: p.short, articleId: p.id })),
    articles,
    panel: {
      tag: proc ? d.procedure.tag : k.collections[doc.collection],
      title: proc ? d.panelTitleProcedure : d.panelTitle,
      description: `${d.cited(totalCited)} · ${k.home.parts(doc.parts.length)}`,
      factsLabel: d.facts,
      facts,
      rulesLabel: d.checks,
      rules,
    },
  };

  const onToken = (token: string) => {
    if (token === 'official' && doc.url) openExternal(ctx, doc.url);
    else if (token === 'text' && doc.textUrl) openExternal(ctx, doc.textUrl);
    else if (token.startsWith('flow:')) ctx.go(SP.flow(token.slice(5)));
    else if (token.startsWith('step:')) {
      const [flow, step] = token.slice(5).split('/');
      ctx.go(SP.flowStep(flow, step));
    } else if (token.startsWith('person:')) ctx.go(SP.person(token.slice(7)));
    else if (token.startsWith('part:')) ctx.go(SP.knowledgeDoc(doc.id, token.slice(5)));
  };

  /* ---- the strip under the title: three places of the same document ---- */
  const usage = usageOf(doc, ctx.state, copy);
  const pages = [
    { id: 'text', label: d.pages.text, icon: Library, active: page === 'text' },
    { id: 'versions', label: d.pages.versions, icon: GitCompareArrows, count: live.versions.length, active: page === 'versions' },
    { id: 'usage', label: d.pages.usage, icon: Workflow, count: usage.reduce((n, g) => n + g.rows.length, 0), active: page === 'usage' },
  ];

  /* ---- the header ---- */
  const actions = proc ? (
    <>
      <Button icon={PenLine} onClick={agentBusy ? false : openChanges} title={agentBusy ? k.changes.running : ctx.deniedTitle('edit:data')}>
        {agentBusy ? k.changes.running : live.draft ? k.changes.button : k.changes.buttonApproved}
      </Button>
      {live.draft && <Button variant="primary" icon={CircleCheck} onClick={approve} title={approveTitle}>{k.approve.button}</Button>}
    </>
  ) : doc.url ? (
    <Button icon={ExternalLink} onClick={() => openExternal(ctx, doc.url as string)} title={doc.host}>{d.officialButton}</Button>
  ) : null;

  /* ---- the text ---- */
  const partModels: PartCardModel[] = doc.parts.map((p) => ({
    id: p.id,
    heading: p.heading,
    quote: p.quote,
    summary: p.summary,
    rests: (p.rests ?? []).map((r) => ({ id: r, label: refLabel(r, contracts, copy) })),
    checks: (p.checks ?? []).map((c, i) => ({ id: c.flow ? `${c.flow}/${c.step ?? ''}#${i}` : `#${i}`, label: c.label })),
    cited: citedCount(doc, p),
    official: !proc && !!(p.url ?? doc.url),
  }));
  const openCheck = (id: string) => {
    const [where] = id.split('#');
    if (!where) return;
    const [flow, step] = where.split('/');
    ctx.go(step ? SP.flowStep(flow, step) : SP.flow(flow));
  };
  const procBanner = proc && (
    <Card tone={live.draft ? 'amber' : 'green'} className="mb-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="min-w-0 flex-1 basis-64">
          <span className="mb-1 flex flex-wrap items-center gap-2">
            {live.draft ? <Chip tone="pink" icon={Sparkles}>{copy.common.ai}</Chip> : <Chip tone="green" icon={CircleCheck}>{d.procedure.approved}</Chip>}
            {agentBusy && <Chip tone="blue">{k.changes.running}</Chip>}
          </span>
          <span className="block text-prose leading-6 text-app-text">
            {live.draft ? d.procedure.draftNote(nameOf(proc.writtenBy), nameOf(proc.approver)) : d.procedure.approvedBy(nameOf(proc.approver))}
          </span>
        </span>
        <span className="flex flex-wrap gap-1.5">
          {proc.flows.map((f) => (
            <button key={f} type="button" onClick={() => ctx.go(SP.flow(f))} className={clsx('rounded', FOCUS_RING)}>
              <Chip tone="blue">{opsFlowById(f)?.name ?? f}</Chip>
            </button>
          ))}
        </span>
      </div>
    </Card>
  );
  const body = page === 'text' ? (
    <div className={READING_COLUMN}>
      {procBanner}
      <div className="mb-4 flex flex-wrap gap-1.5" aria-label={d.parts}>
        {doc.parts.map((p) => (
          <button key={p.id} type="button" aria-current={p.id === focusId || undefined} onClick={() => focusPart(p.id)} className={clsx('rounded', FOCUS_RING)}>
            <Chip tone={p.id === focusId ? 'blue' : 'neutral'} strong={p.id === focusId}>{p.short}</Chip>
          </button>
        ))}
      </div>
      <div className="mb-4 space-y-3">
        <AskBox
          copy={boxCopy}
          value={input}
          onChange={setInput}
          onAsk={run}
          suggestions={suggestionsFor(doc.id)}
          asked={!!fullAnswer}
          onClear={() => { setAsked(null); setInput(''); }}
        />
        {fullAnswer && (
          <AnswerCard
            answer={fullAnswer}
            copy={boxCopy}
            onOpenSource={(src) => { if (src.id) ctx.go(refPath(src.id)); }}
            onOpenPassage={(p) => ctx.go(refPath(p.sourceId))}
          />
        )}
      </div>
      <div className="space-y-3">
        {partModels.map((p) => (
          <PartCard
            key={p.id}
            part={p}
            copy={copy}
            focused={p.id === focusId}
            onFocus={focusPart}
            onOpenRest={(ref) => ctx.go(refPath(ref))}
            onOpenCheck={openCheck}
            onOpenOfficial={(id) => {
              const url = doc.parts.find((x) => x.id === id)?.url ?? doc.url;
              if (url) openExternal(ctx, url);
            }}
          />
        ))}
      </div>
      {proc && (
        <Card title={d.procedure.mistakes} icon={TriangleAlert} tone="amber" className="mt-4">
          <p className="text-prose leading-6 text-app-text">{proc.mistakes}</p>
        </Card>
      )}
    </div>
  ) : undefined;

  return (
    <>
      <KnowledgeScreen
        doc={model}
        copy={boxCopy}
        phone={ctx.phone}
        tab={TAB_OF[page]}
        hideTree
        hideTabs
        belowHeader={(
          <>
            <KnowledgeNav ctx={ctx} active={section} />
            <div className={`shrink-0 ${PAGE_GUTTER} pt-3`}>
              <h1 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{doc.title}</h1>
              {doc.subtitle && <p className="mt-0.5 text-prose text-app-text-secondary">{doc.subtitle}</p>}
              <p className="mt-0.5 text-compact text-app-text-tertiary">{`${doc.issuer} · ${doc.note}`}</p>
              <SubNav label={d.pages.label} items={pages} onSelect={(id) => ctx.go(id === 'text' ? SP.knowledgeDoc(doc.id) : SP.knowledgeDocPage(doc.id, id as DocPage))} className="mt-2" />
            </div>
          </>
        )}
        focusArticleId={focusId}
        onFocusArticle={focusPart}
        onOpenRecord={(id) => ctx.go(usagePath(id))}
        selectedItemId={doc.id}
        versions={live.versions}
        usage={usage}
        onOpenUsage={(_g, row) => ctx.go(usagePath(row))}
        actions={actions}
        onRuleAction={onToken}
        onFactAction={onToken}
        backSlot={back}
      >
        {body}
      </KnowledgeScreen>
      {changesOpen && proc && (
        <Dialog
          title={k.changes.title(doc.label)}
          closeLabel={copy.common.close}
          onClose={closeChanges}
          footer={(
            <>
              <Button variant="ghost" onClick={closeChanges}>{k.changes.cancel}</Button>
              <Button variant="primary" icon={PenLine} onClick={sendChanges}>{k.changes.send}</Button>
            </>
          )}
        >
          <TextArea
            label={k.changes.label}
            value={note}
            onChange={(v) => { setNote(v); if (noteError) setNoteError(''); }}
            placeholder={k.changes.placeholder}
            rows={4}
            hint={noteError ? <span className="text-rose-600 dark:text-rose-400">{noteError}</span> : k.changes.hint}
          />
        </Dialog>
      )}
    </>
  );
}
