/**
 * The places of the `knowledge-more` area: the collections and the question
 * box (n13), a document by article (x03), its signed original and who cites it
 * (v03), a procedure the AI wrote (x04) and the map of who knows what (o03).
 * See `../kit.ts` for the contract; the wiring of each place is in
 * `knowledge-more/`.
 */
import { BookOpen, FileText, Network, ScrollText } from 'lucide-react';
import type { AreaModule, ScreenCtx, SearchEntry } from '../kit';
import { COLLECTIONS, PROCEDURES, plainText } from '../../../ui/fixtures/knowledge-more';
import { P } from '../paths';
import { CollectionsPlace } from './knowledge-more/collections';
import { DocPlace } from './knowledge-more/doc';
import { articleShort, articlesOf, allItems, getItem } from './knowledge-more/engine';
import { MapPlace } from './knowledge-more/map';
import { OriginalPlace } from './knowledge-more/original';
import { ProcedurePlace } from './knowledge-more/procedure';
import { DOCS_INIT, DOCS_SLICE, type DocsState } from './knowledge-more/state';

const docsOf = (ctx: ScreenCtx): DocsState => (ctx.state.slices[DOCS_SLICE] as DocsState | undefined) ?? DOCS_INIT;

const COMMON = { org: 'nocera' as const, nav: 'knowledge' as const, needs: 'view:knowledge' as const };

export const KNOWLEDGE_AREA: AreaModule = {
  screens: [
    {
      ...COMMON,
      id: 'n13',
      path: '/conoscenza',
      samples: [P.knowledge()],
      title: (_p, ctx) => ctx.copy.knowledge.root,
      render: (_p, ctx) => <CollectionsPlace ctx={ctx} />,
    },
    {
      ...COMMON,
      id: 'n13',
      path: '/conoscenza/cerca/:q',
      samples: [P.knowledgeSearch('Chi può contestare uno scarico abusivo in un canale consortile, e dove vanno i soldi della sanzione?'), P.knowledgeSearch('Quanti km di rete idraulica ha il Consorzio?'), P.knowledgeSearch('xyzzy')],
      title: (p, ctx) => ctx.copy.knowledgeMore.places.search(p.q),
      render: (p, ctx) => <CollectionsPlace ctx={ctx} q={p.q} />,
    },
    {
      ...COMMON,
      id: 'o03',
      path: '/conoscenza/mappa',
      samples: [P.knowledgeMap()],
      title: (_p, ctx) => ctx.copy.knowledgeMore.places.map,
      render: (_p, ctx) => <MapPlace ctx={ctx} />,
    },
    {
      ...COMMON,
      id: 'x04',
      path: '/conoscenza/procedure/:id',
      samples: PROCEDURES.map((p) => P.procedure(p.id)),
      title: (p) => PROCEDURES.find((x) => x.id === p.id)?.title ?? p.id,
      render: (p, ctx) => <ProcedurePlace ctx={ctx} id={p.id} />,
    },
    {
      ...COMMON,
      id: 'v03',
      path: '/conoscenza/doc/:item/originale',
      samples: [P.knowledgeOriginal('libro-anno-2025'), P.knowledgeOriginal('lr-7-2025'), P.knowledgeOriginal('dlgs-546-1992')],
      title: (p, ctx) => ctx.copy.knowledgeMore.places.original(getItem(docsOf(ctx), p.item)?.label ?? p.item),
      render: (p, ctx) => <OriginalPlace ctx={ctx} itemId={p.item} />,
    },
    {
      ...COMMON,
      id: 'x03',
      path: '/conoscenza/doc/:item/:article',
      samples: [P.knowledgeDoc('lr-7-2025', 'a9c3'), P.knowledgeDoc('libro-anno-2025', 'p444')],
      title: (p, ctx) => getItem(docsOf(ctx), p.item)?.label ?? p.item,
      render: (p, ctx) => <DocPlace ctx={ctx} itemId={p.item} articleId={p.article} />,
    },
    {
      ...COMMON,
      id: 'x03',
      path: '/conoscenza/doc/:item',
      samples: [P.knowledgeDoc('lr-7-2025'), ...allItems(DOCS_INIT).filter((i) => i.id !== 'lr-7-2025').map((i) => P.knowledgeDoc(i.id))],
      title: (p, ctx) => getItem(docsOf(ctx), p.item)?.label ?? p.item,
      render: (p, ctx) => <DocPlace ctx={ctx} itemId={p.item} />,
    },
  ],
  search: (ctx): SearchEntry[] => {
    const docs = docsOf(ctx);
    const s = ctx.copy.knowledgeMore.search;
    const out: SearchEntry[] = [
      { id: 'kn-home', group: s.groupKnowledge, title: ctx.copy.knowledge.root, detail: COLLECTIONS.map((c) => c.label).join(', '), keywords: COLLECTIONS.map((c) => c.label).join(' '), path: P.knowledge(), icon: BookOpen, needs: 'view:knowledge' },
      { id: 'kn-map', group: s.groupKnowledge, title: ctx.copy.knowledgeMore.places.map, detail: ctx.copy.knowledgeMore.map.subtitle, path: P.knowledgeMap(), icon: Network, needs: 'view:knowledge' },
    ];
    for (const item of allItems(docs)) {
      const group = item.collection === 'norme' ? s.groupNorms : s.groupDocuments;
      out.push({ id: `kn-${item.id}`, group, title: item.label, detail: item.subtitle ?? item.title, keywords: [item.title, item.keywords ?? ''].join(' '), path: P.knowledgeDoc(item.id), icon: BookOpen, needs: 'view:knowledge' });
      for (const a of articlesOf(item, docs)) {
        out.push({
          id: `kn-${item.id}-${a.id}`,
          group,
          title: `${item.label} · ${articleShort(a)}`,
          detail: a.heading.includes(' · ') ? a.heading.split(' · ').slice(1).join(' · ') : item.title,
          keywords: `${a.heading} ${plainText(a.text)} ${a.subject ?? ''}`,
          path: P.knowledgeDoc(item.id, a.id),
          icon: ScrollText,
          needs: 'view:knowledge',
        });
      }
    }
    for (const p of PROCEDURES) {
      out.push({ id: `kn-proc-${p.id}`, group: s.groupProcedures, title: p.title, detail: p.who, keywords: `${p.programs.join(' ')} ${p.steps.map((x) => x.text).join(' ')}`, path: P.procedure(p.id), icon: FileText, needs: 'view:knowledge' });
    }
    return out;
  },
};

