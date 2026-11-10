/**
 * orbit-knowledge and orbit-rules: the two lists of «Conoscenza» that hold
 * documents. «Documents» are the papers of the company, «Rules» are the laws
 * and the procedures the flows follow. Each has the question box over every
 * document (answers only with the parts it quotes), the questions asked
 * lately, the parts the work cites most, and the list with the filter bar.
 * The question on show stays in the container, so a reload keeps it.
 */
import { useMemo, type ReactNode } from 'react';
import { BookOpen, CalendarDays, ChevronRight, CircleCheck, FileText, ListChecks, MessageSquareText, ScrollText, Sparkles, Workflow } from 'lucide-react';
import clsx from 'clsx';
import { AnswerCard } from '../../../../ui/knowledge/AnswerCard';
import { AskBox } from '../../../../ui/knowledge/AskBox';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { Card } from '../../../../ui/primitives/Card';
import { Chip, Count } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Table } from '../../../../ui/primitives/Table';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import { world } from '../../world';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { flowLabel } from '../../model/flows';
import { liveContracts } from '../../model/live';
import { when } from '../../model/words';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import {
  ask, askCopy, citedCount, draftsOf, flowsOf, KNOWLEDGE_INITIAL, KNOWLEDGE_SLICE, liveDocs, recordQuestion, refPath, sourcesLine, suggestionsFor,
  updatedOf, type KnowledgeSlice, type LiveDoc,
} from './engine';
import { KnowledgeNav, type KnowledgeSection } from './KnowledgeNav';
import { isCompanyDoc } from './collections';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';

const COLLECTION_ICON = { norme: ScrollText, azienda: FileText, procedure: ListChecks } as const; // allow-italian: collection ids of the data

type DocKind = 'law' | 'procedure' | 'company';

const kindOf = (d: LiveDoc): DocKind => (isCompanyDoc(d.doc.collection) ? 'company' : d.doc.procedure ? 'procedure' : 'law');
const docCited = (d: LiveDoc) => d.doc.parts.reduce((n, p) => n + citedCount(d.doc, p), 0);

/** An issuer that lists a dozen associations reads as its first name. */
const issuerShort = (issuer: string) => {
  const first = issuer.split(';')[0].trim();
  /* The organization writes its own legal name in full on every document: its short name says the same. */
  if (first === world().words.legalName) return world().shortName;
  return first.length > 46 ? `${first.slice(0, 44).trimEnd()}…` : first;
};

/** A part heading without the number in front of it (`§ 3.5.1 · Ritiro su chiamata` reads `Ritiro su chiamata`). */
const partName = (heading: string) => heading.replace(/^§\s*[\d.]+\s*·\s*/, '');

/** A titled card of rows that open something. */
function RowCard({ title, icon, empty, children }: { title: string; icon: typeof FileText; empty?: string; children: ReactNode }) {
  return (
    <Card title={title} icon={icon}>
      {empty ? <p className="text-compact text-app-text-tertiary">{empty}</p> : <ul className="-mx-2 space-y-0.5">{children}</ul>}
    </Card>
  );
}

function OpenRow({ label, detail, trailing, onOpen }: { label: string; detail?: string; trailing?: ReactNode; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-prose font-medium text-app-text">{label}</span>
          {detail && <span className="block truncate text-compact text-app-text-tertiary">{detail}</span>}
        </span>
        {trailing ?? <ChevronRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
      </button>
    </li>
  );
}

/** The state of a document in a list: a procedure an agent wrote says only that it waits, with the glyph of the agent, so its name keeps the room. */
function DocState({ doc, waiting }: { doc: LiveDoc; waiting: string }) {
  return doc.draft ? <Chip tone="amber" icon={Sparkles}>{waiting}</Chip> : <Chip tone={doc.status.tone}>{doc.status.text}</Chip>;
}

export function HomeScreen({ ctx, section }: { ctx: ScreenCtx; section: Extract<KnowledgeSection, 'documents' | 'rules'> }) {
  const copy = ctx.copy;
  const k = copy.orbitData.knowledge;
  const h = k.home;
  const l = k.list;
  const [slice] = ctx.slice<KnowledgeSlice>(KNOWLEDGE_SLICE, KNOWLEDGE_INITIAL);
  const [input, setInput] = ctx.ui<string>('orbit.k.input.home', '');
  const [asked, setAsked] = ctx.ui<string | null>('orbit.k.ask.home', null);
  const everyDoc = liveDocs(slice, copy);
  const isRules = section === 'rules';
  const listLabel = isRules ? h.rulesLabel : h.documentsLabel;
  const emptyList = isRules ? l.emptyRules : l.empty;
  const docs = everyDoc.filter((d) => isCompanyDoc(d.doc.collection) === (section === 'documents'));
  const contracts = liveContracts(ctx.state);
  const drafts = draftsOf(docs);
  const boxCopy = askCopy(copy, ctx.phone ? k.ask.placeholderPhone : k.ask.placeholder);
  const answer = asked ? ask(asked, everyDoc, contracts, copy) : undefined;
  const open = (docId: string, part?: string) => ctx.go(SP.knowledgeDoc(docId, part));

  const run = (question: string) => {
    if (!question) {
      ctx.toast({ tone: 'info', title: k.ask.empty });
      return;
    }
    setInput(question);
    setAsked(question);
    recordQuestion(ctx, question);
  };

  /* the questions asked here, then the ones people ask often */
  const recent: Array<{ question: string; detail: string }> = [];
  for (const x of slice.asked ?? []) {
    const doc = x.doc ? everyDoc.find((d) => d.doc.id === x.doc) : undefined;
    recent.push({ question: x.question, detail: doc ? `${h.asked(when(ctx, x.at))} · ${doc.doc.label}` : h.asked(when(ctx, x.at)) });
  }
  for (const q of world().knowledge.questions) {
    if (recent.some((r) => r.question === q.question)) continue;
    recent.push({ question: q.question, detail: sourcesLine(q.answer.map((a) => a.source), contracts, copy) });
  }

  /* the documents of this list the work cites most: one row per document, with the same total as its row in the table and the parts that make it up */
  const mostCited = docs
    .map((d) => ({
      doc: d.doc,
      count: docCited(d),
      parts: d.doc.parts.map((p) => ({ part: p, count: citedCount(d.doc, p) })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count),
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.doc.label.localeCompare(b.doc.label))
    .slice(0, 5);

  /* the list and its filters */
  const schema = useMemo<FilterSchema<LiveDoc>>(() => ({
    text: (d) => `${d.doc.label} ${d.doc.title} ${d.doc.subtitle ?? ''} ${d.doc.issuer} ${d.doc.note} ${d.doc.keywords ?? ''}`,
    fields: [
      { id: 'tipo', label: l.fields.type, icon: BookOpen, kind: 'choice', get: kindOf, valueLabel: (v) => l.types[v as DocKind], order: ['law', 'procedure', 'company'] },
      { id: 'emittente', label: l.fields.issuer, icon: FileText, kind: 'choice', get: (d) => d.doc.issuer, valueLabel: issuerShort },
      { id: 'flusso', label: l.fields.flow, icon: Workflow, kind: 'choice', get: (d) => flowsOf(d.doc), valueLabel: flowLabel },
      { id: 'state', label: l.fields.state, icon: CircleCheck, kind: 'choice', get: (d) => (d.draft ? 'draft' : 'current'), valueLabel: (v) => l.states[v as 'draft' | 'current'], order: ['draft', 'current'], values: ['draft', 'current'] },
      { id: 'updated', label: l.fields.updated, icon: CalendarDays, kind: 'date', ops: ['before', 'after'], get: (d) => updatedOf(d.doc) },
    ],
  }), [l]);
  const presets = useMemo<SavedFilter[]>(() => (isRules
    ? [
      { id: 'draft', name: l.saved.draft, tokens: [{ id: 'p1', field: 'state', op: 'is', value: 'draft' }] },
      { id: 'law', name: l.saved.law, tokens: [{ id: 'p2', field: 'tipo', op: 'is', value: 'law' }] },
      { id: 'procedure', name: l.saved.procedure, tokens: [{ id: 'p3', field: 'tipo', op: 'is', value: 'procedure' }] },
    ]
    : []), [section, l]);
  const list = useListFilters(ctx, { key: `orbit.k.filters.${section}`, items: docs, schema, presets });
  const shown = list.items;
  /* When every document on show comes from the same issuer the column repeats one name on each row: it is left out. */
  const sameIssuer = shown.length > 1 && new Set(shown.map((d) => issuerShort(d.doc.issuer))).size === 1;

  const crumbs = orgCrumbs(ctx, [{ label: k.title, to: SP.knowledge() }, { label: copy.orbitData.section[section], detail: (isRules ? h.ruleCount : h.docCount)(docs.length) }]);

  const recentCard = (
    <RowCard title={h.recent} icon={MessageSquareText} empty={recent.length ? undefined : h.recentEmpty}>
      {recent.slice(0, 5).map((r) => (
        <OpenRow key={r.question} label={r.question} detail={r.detail} trailing={<MessageSquareText size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />} onOpen={() => run(r.question)} />
      ))}
    </RowCard>
  );
  const citedCard = (
    <RowCard title={h.cited} icon={BookOpen}>
      {mostCited.map((m) => (
        <OpenRow
          key={m.doc.id}
          label={m.doc.label}
          detail={m.parts.slice(0, 2).map((x) => `${partName(x.part.heading)} · ${h.citedCount(x.count)}`).join('; ')}
          trailing={<span data-tip={h.citedCount(m.count)}><Count value={m.count} tone="blue" /></span>}
          onOpen={() => open(m.doc.id, m.parts[0]?.part.id)}
        />
      ))}
    </RowCard>
  );
  const listSection = (
    <section aria-label={listLabel} className="space-y-3">
      <FilterBar copy={copy} {...list.bar} placeholder={copy.filters.on.documents} phone={ctx.phone} />
      {shown.length === 0 ? (
        <EmptyState icon={FileText} title={emptyList.title} className="min-h-0 rounded-lg border border-app-border bg-surface py-10">{emptyList.body}</EmptyState>
      ) : ctx.phone ? (
        <ul aria-label={listLabel} className="divide-y divide-app-border overflow-hidden rounded-lg border border-app-border bg-surface">
          {shown.map((d) => {
            const Icon = COLLECTION_ICON[d.doc.collection];
            return (
              <li key={d.doc.id}>
                <button type="button" data-doc={d.doc.id} onClick={() => open(d.doc.id)} className={clsx('flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left hover:bg-app-hover', FOCUS_RING)}>
                  <Icon size={14} className="mt-0.5 shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-prose font-semibold text-app-text">{d.doc.label}</span>
                    <span className="block text-compact leading-4 text-app-text-secondary">{d.doc.title === d.doc.label ? d.doc.subtitle ?? '' : d.doc.title}</span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <DocState doc={d} waiting={k.versions.toApprove} />
                      <span className="text-compact text-app-text-tertiary">{h.citedCount(docCited(d))}</span>
                    </span>
                  </span>
                  <ChevronRight size={14} className="mt-0.5 shrink-0 text-app-text-tertiary" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Table
          ariaLabel={listLabel}
          columns={[
            { id: 'doc', label: isRules ? h.columns.rule : h.columns.doc },
            ...(sameIssuer ? [] : [{ id: 'issuer', label: h.columns.issuer, width: 200 }]),
            { id: 'status', label: h.columns.status, width: 170 },
            { id: 'updated', label: h.columns.updated, width: 110 },
            { id: 'cited', label: h.columns.cited, width: 90, align: 'right' },
          ]}
          rows={shown.map((d) => {
            const Icon = COLLECTION_ICON[d.doc.collection];
            const updated = updatedOf(d.doc);
            return {
              id: d.doc.id,
              onOpen: () => open(d.doc.id),
              cells: {
                doc: (
                  <span data-doc={d.doc.id} className="flex min-w-0 items-start gap-2">
                    <Icon size={14} className="mt-0.5 shrink-0 text-app-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0">
                      <b className="block font-semibold [overflow-wrap:break-word]">{d.doc.label}</b>
                      {/* A title that repeats the name says nothing: the line under the name is then what the document is. */}
                      <span className="block text-compact text-app-text-tertiary [overflow-wrap:break-word]">{d.doc.title === d.doc.label ? d.doc.subtitle ?? '' : d.doc.title}</span>
                    </span>
                  </span>
                ),
                ...(sameIssuer ? {} : { issuer: issuerShort(d.doc.issuer) }),
                status: <DocState doc={d} waiting={k.versions.toApprove} />,
                updated: <span className={updated ? 'tabular-nums' : 'text-app-text-faint'}>{updated ? formatDay(updated) : copy.orbitData.common.blank}</span>,
                cited: String(docCited(d)),
              },
            };
          })}
        />
      )}
    </section>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={crumbs}
        status={drafts.length > 0 && (
          <button type="button" onClick={() => open(drafts[0].doc.id)} data-tip={drafts[0].doc.label} className={clsx('rounded', FOCUS_RING)}>
            <Chip tone="amber" icon={Sparkles}>{h.drafts(drafts.length)}</Chip>
          </button>
        )}
      />
      <KnowledgeNav ctx={ctx} active={section} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`min-w-0 space-y-4 ${PAGE_GUTTER} py-4`}>
          {isRules && (
            <>
              <AskBox
                copy={boxCopy}
                value={input}
                onChange={setInput}
                onAsk={run}
                suggestions={suggestionsFor()}
                asked={!!answer}
                onClear={() => { setAsked(null); setInput(''); }}
              />
              {answer && (
                <AnswerCard
                  answer={answer}
                  copy={boxCopy}
                  onOpenSource={(src) => { if (src.id) ctx.go(refPath(src.id)); }}
                  onOpenPassage={(p) => ctx.go(refPath(p.sourceId))}
                />
              )}
            </>
          )}
          {isRules ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {recentCard}
                {citedCard}
              </div>
              {listSection}
            </>
          ) : (
            <>
              {listSection}
              {mostCited.length > 0 && citedCard}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
