/**
 * x03: a document of the knowledge base, split by article, with its versions
 * and what cites it. The place for `/conoscenza/doc/:item` and
 * `/conoscenza/doc/:item/:article`.
 */
import { FileSignature } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Toggle } from '../../../../ui/primitives/Field';
import { KnowledgeScreen } from '../../../../ui/knowledge/KnowledgeScreen';
import type { ArticleModel, KnowledgeModel, KnowledgeTab, VersionModel } from '../../../../ui/knowledge/model';
import { COLLECTIONS, PROCEDURES, findArticle } from '../../../../ui/fixtures/knowledge-more';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { P } from '../../paths';
import {
  articlesOf, citingCases, getItem, ruleFlowPath,
} from './engine';
import { DOCS_INIT, DOCS_SLICE, PROCEDURES_SLICE, type DocsState, type ProceduresState } from './state';
import { openUsage, treeCollections, usageGroups } from './helpers';

const TONE = { green: 'green', amber: 'amber', neutral: 'neutral', red: 'red' } as const;

export function DocPlace({ ctx, itemId, articleId }: { ctx: ScreenCtx; itemId: string; articleId?: string }) {
  const copy = ctx.copy;
  const k = copy.knowledgeMore.doc;
  const [docs, setDocs] = ctx.slice<DocsState>(DOCS_SLICE, DOCS_INIT);
  const [procs] = ctx.slice<ProceduresState>(PROCEDURES_SLICE, {});
  const [tab, setTab] = ctx.ui<KnowledgeTab>('kn.doc.tab', 'text');
  const [overrides, setOverrides] = ctx.ui<Record<string, boolean>>('kn.tree', {});
  const item = getItem(docs, itemId);
  const currentCollection = item?.collection;
  const expanded = (id: string) => overrides[id] ?? id === currentCollection;
  const collections = treeCollections(ctx, docs, expanded);
  const tree = {
    collections,
    expanded: collections.filter((c) => c.expanded).map((c) => c.id),
    toggle: (id: string) => setOverrides((o) => ({ ...o, [id]: !(o[id] ?? id === currentCollection) })),
    select: (id: string) => {
      if (id === 'staff') ctx.go(P.knowledge());
      else if (PROCEDURES.some((p) => p.id === id)) ctx.go(P.procedure(id));
      else ctx.go(P.knowledgeDoc(id));
    },
  };
  const crumbCollection = COLLECTIONS.find((c) => c.id === currentCollection)?.label ?? copy.knowledge.collections;

  if (!item) {
    const empty: KnowledgeModel = {
      crumbs: [{ label: copy.knowledge.root }, { label: itemId }],
      status: { text: '', tone: 'neutral' },
      collections,
      selectedId: '',
      title: itemId,
      articleTabs: [],
      articles: [],
      panel: { tag: '', title: '', description: '', factsLabel: '', facts: [], rulesLabel: '', rules: [], changeLabel: '', changeText: '' },
    };
    return (
      <KnowledgeScreen
        doc={empty}
        copy={copy}
        loaded={false}
        phone={ctx.phone}
        expandedCollections={tree.expanded}
        onToggleCollection={tree.toggle}
        onSelectItem={tree.select}
      >
        <EmptyState title={k.notFoundTitle}>
          {k.notFoundBody}
          <div className="mt-3"><Button variant="primary" onClick={() => ctx.go(P.knowledge())}>{k.backToKnowledge}</Button></div>
        </EmptyState>
      </KnowledgeScreen>
    );
  }

  const articles = articlesOf(item, docs);
  const focus = (findArticle({ ...item, articles }, articleId) ?? articles[0]);
  const canLoad = ctx.can('edit:data');
  const pendingFirst = articles.find((a) => a.subject);

  /* ---- the articles, each with the cases that cite it ---- */
  const articleModels: ArticleModel[] = articles.map((a) => ({
    id: a.id,
    heading: a.heading,
    source: a.source,
    text: a.text ?? [],
    rules: a.rules,
    pending: a.subject ? { subject: a.subject, officialSource: item.officialSource } : undefined,
    usedBy: citingCases(item.id, item, a).map(({ seed }) => ({ id: seed.id, title: `${seed.id} · ${seed.title}`, detail: OFFICE_LABEL[seed.office] })),
  }));

  const watch = !!docs.watch[item.id];
  const stillPending = articles.some((a) => a.subject);
  const panelFacts = item.facts.map((f) => (f.pending && !stillPending
    ? { label: f.label, value: k.textLoaded }
    : { label: f.label, value: f.value, pending: f.pending, action: f.pending ? 'load' : f.item ? `item:${f.item}` : undefined }));
  const model: KnowledgeModel = {
    crumbs: [{ label: copy.knowledge.root }, { label: crumbCollection }, { label: item.title }],
    status: { text: item.status.text, tone: TONE[item.status.tone] },
    collections,
    selectedId: item.id,
    title: item.title,
    subtitle: item.subtitle,
    articleTabs: item.chips.map((c) => ({ id: c.id, label: c.label, articleId: c.articleId })),
    articles: articleModels,
    panel: {
      tag: item.collection === 'norme' ? k.panelTagNorm : k.panelTagDocument,
      title: k.panelTitle,
      description: k.panelDescription(item.officialSource),
      factsLabel: k.factsLabel,
      facts: panelFacts,
      rulesLabel: k.rulesLabel,
      rules: item.ruleRows.map((r) => ({ label: r.label, value: r.value, action: r.flow ? `flow:${r.flow}` : undefined })),
      changeLabel: k.changeLabel,
      changeText: k.changeText,
    },
  };

  /* ---- versions ---- */
  const versions: VersionModel[] = item.versions.map((v) => ({
    id: v.id,
    label: v.label,
    detail: v.detail,
    status: { text: v.status.text, tone: TONE[v.status.tone] },
    current: v.current,
    openLabel: v.item ? k.openVersion : undefined,
    pendingLoad: !!v.pending && canLoad,
  }));

  const loadText = () => {
    setTab('text');
    if (pendingFirst) ctx.go(P.knowledgeDoc(item.id, pendingFirst.id));
    ctx.toast({ tone: 'info', title: k.loadHint });
  };
  const pasteText = (aid: string, text: string) => {
    if (!text) {
      ctx.toast({ tone: 'warn', title: k.pasteEmpty });
      return;
    }
    const heading = articles.find((a) => a.id === aid)?.heading ?? aid;
    setDocs((d) => ({ ...d, pasted: { ...d.pasted, [`${item.id}/${aid}`]: { text, by: ctx.persona.name, at: ctx.now } } }));
    ctx.log(k.pasteLog(item.label, heading), 'knowledge', P.knowledgeDoc(item.id, aid));
    ctx.toast({ tone: 'ok', title: k.pasteDone(heading), body: k.pasteDoneBody });
  };

  return (
    <KnowledgeScreen
      doc={model}
      copy={copy}
      phone={ctx.phone}
      tab={tab}
      onTabChange={setTab}
      focusArticleId={focus?.id}
      onFocusArticle={(id) => ctx.go(P.knowledgeDoc(item.id, id))}
      onOpenRecord={(id) => ctx.go(P.record(id))}
      selectedItemId={item.id}
      onSelectItem={tree.select}
      expandedCollections={tree.expanded}
      onToggleCollection={tree.toggle}
      versions={versions}
      onOpenVersion={(vid) => {
        const v = item.versions.find((x) => x.id === vid);
        if (v?.item) ctx.go(P.knowledgeDoc(v.item));
      }}
      onLoadText={loadText}
      usage={usageGroups(ctx, item, docs, procs)}
      onOpenUsage={(g, r) => openUsage(ctx, g, r)}
      actions={<Button icon={FileSignature} onClick={() => ctx.go(P.knowledgeOriginal(item.id))}>{k.openOriginal}</Button>}
      onRuleAction={(token) => {
        if (token.startsWith('flow:')) ctx.go(ruleFlowPath(token.slice(5) || undefined));
        else {
          // A rule chip names a rule, not a flow: the first rule row of the item says where it leads.
          const row = item.ruleRows.find((r) => r.flow !== undefined);
          ctx.go(ruleFlowPath(row?.flow));
        }
      }}
      onFactAction={(token) => {
        if (token === 'load') loadText();
        else if (token.startsWith('item:')) ctx.go(P.knowledgeDoc(token.slice(5)));
      }}
      onPasteText={canLoad ? pasteText : undefined}
      officialSource={item.officialSource}
      panelExtra={(
        <div className="mt-2.5 border-t border-app-border pt-2.5">
          <Toggle
            checked={watch}
            onChange={(on) => {
              setDocs((d) => ({ ...d, watch: { ...d.watch, [item.id]: on } }));
              ctx.log((on ? k.followOn : k.followOff)(item.label), 'knowledge');
              ctx.toast({ tone: 'info', title: (on ? k.followOn : k.followOff)(item.label) });
            }}
            label={k.followLabel}
            description={k.followHint}
          />
        </div>
      )}
    />
  );
}
