/**
 * v03: the signed original of a document and who cites it. The place for
 * `/conoscenza/doc/:item/originale`.
 */
import { BackButton } from '../../../../ui/shell/PaneHeader';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Button } from '../../../../ui/primitives/Button';
import { OriginalScreen, type OriginalModel, type OriginalTab } from '../../../../ui/knowledge/OriginalScreen';
import { COLLECTIONS } from '../../../../ui/fixtures/knowledge-more';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { articlesOf, getItem, itemPath, stamp } from './engine';
import { usageGroups, openUsage } from './helpers';
import { DOCS_INIT, DOCS_SLICE, PROCEDURES_SLICE, type DocsState, type ProceduresState } from './state';

const capitalize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function OriginalPlace({ ctx, itemId }: { ctx: ScreenCtx; itemId: string }) {
  const copy = ctx.copy;
  const o = copy.knowledgeMore.original;
  const [docs, setDocs] = ctx.slice<DocsState>(DOCS_SLICE, DOCS_INIT);
  const [procs] = ctx.slice<ProceduresState>(PROCEDURES_SLICE, {});
  const [tab, setTab] = ctx.ui<OriginalTab>('kn.orig.tab', 'original');
  const item = getItem(docs, itemId);
  if (!item) {
    return (
      <EmptyState title={copy.knowledgeMore.doc.notFoundTitle}>
        {copy.knowledgeMore.doc.notFoundBody}
        <div className="mt-3"><Button variant="primary" onClick={() => ctx.go(P.knowledge())}>{copy.knowledgeMore.doc.backToKnowledge}</Button></div>
      </EmptyState>
    );
  }
  const articles = articlesOf(item, docs);
  const collection = COLLECTIONS.find((c) => c.id === item.collection)?.label ?? '';
  const org = item.original;
  const checkedAt = docs.checked[item.id];
  const job = ctx.job(`kn-check-${item.id}`);
  const pendingFirst = articles.find((a) => a.subject);

  const model: OriginalModel = {
    crumbs: [{ label: copy.knowledge.root }, { label: collection }, { label: org.paragraphs ? `${item.label} · ${capitalize(org.heading)}` : item.label }],
    title: item.title,
    description: [item.subtitle, item.versions[0]?.detail].filter(Boolean).join('. '),
    paper: { heading: org.heading, publication: org.publication, paragraphs: org.paragraphs, page: org.page, notLoaded: org.notLoaded },
    facts: item.facts.map((f) => ({ label: f.label, value: f.value, pending: f.pending && articles.some((a) => a.subject) })),
    articles: articles.map((a) => ({ id: a.id, heading: a.heading, note: a.text ? (a.source ?? '') : (a.subject ?? ''), pending: !!a.subject })),
    extracted: articles.map((a) => ({ id: a.id, heading: a.heading, page: a.page, text: a.text, subject: a.subject })),
    source: org.publication.filter((r) => !org.site || r.label !== 'Fonte'),
    site: org.site && org.siteCheck ? { label: org.site.label, check: org.siteCheck, ok: true, at: checkedAt ? stamp(checkedAt) : undefined } : undefined,
    refs: item.refs.map((r, i) => ({ id: String(i), label: r.label, pending: r.pending, openable: !!r.item && !!getItem(docs, r.item) })),
    cited: usageGroups(ctx, item, docs, procs),
  };

  const openSite = org.site
    ? () => ctx.confirm({
      title: o.openSiteTitle,
      body: o.openSiteBody(org.site?.label ?? ''),
      confirmLabel: o.openSiteConfirm,
      onConfirm: () => { window.open(org.site?.url, '_blank', 'noopener'); },
    })
    : undefined;

  return (
    <OriginalScreen
      copy={copy}
      phone={ctx.phone}
      model={model}
      tab={tab}
      onTab={setTab}
      onOpenSite={openSite}
      checking={job?.status === 'running'}
      onRecheck={org.site ? () => ctx.startJob({
        id: `kn-check-${item.id}`,
        title: o.recheckJob.title,
        steps: [{ label: o.recheckJob.steps[0], ms: 900 }, { label: o.recheckJob.steps[1], ms: 800 }],
        onDone: (ok) => {
          if (!ok) return;
          setDocs((d) => ({ ...d, checked: { ...d.checked, [item.id]: ctx.now } }));
          ctx.log(o.recheckLog(item.label), 'knowledge', P.knowledgeOriginal(item.id));
          ctx.toast({ tone: 'ok', title: o.recheckDone });
        },
      }) : undefined}
      onOpenRef={(i) => {
        const ref = item.refs[Number(i)];
        if (ref?.item) ctx.go(itemPath(ref.item, ref.article));
      }}
      onOpenCited={(g, r) => openUsage(ctx, g, r)}
      onOpenArticle={(aid) => ctx.go(P.knowledgeDoc(item.id, aid))}
      onLoadOriginal={ctx.can('edit:data') && pendingFirst ? () => ctx.go(P.knowledgeDoc(item.id, pendingFirst.id)) : undefined}
      onBack={<BackButton label={item.label} onClick={() => ctx.go(P.knowledgeDoc(item.id))} copy={copy} />}
    />
  );
}
