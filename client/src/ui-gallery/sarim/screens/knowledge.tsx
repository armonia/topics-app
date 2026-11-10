/**
 * SARIM edition, area «Conoscenza», its two lists of documents: the company's own
 * papers («Documenti») and the laws and procedures the agents follow
 * («Regole»), each split in parts that cards, flow steps and contract clauses
 * cite. A document has three pages (text, versions, where it is used), each at
 * its own address. Contracts and data are the other two sections
 * (`contracts.tsx`, `data.tsx`). The words are in
 * `ctx.copy.sarimData.knowledge`, the documents in
 * `fixtures/sarim-org/knowledge.ts`, what the reader changed (approvals,
 * rewrites, questions) in the `sarim.knowledge` slice.
 */
import { knowledgeDocById, world } from '../world';
import type { AreaModule, ScreenDef } from '../../app/kit';
import { SP } from '../paths';
import { DocScreen, type DocPageId } from './knowledge/DocScreen';
import { HomeScreen } from './knowledge/HomeScreen';

const base = { org: world().key, nav: 'knowledge', needs: 'view:knowledge' } as const;

const docTab = (p: Record<string, string>) => ({ label: knowledgeDocById(p.doc)?.label ?? p.doc });
const docTitle = (p: Record<string, string>) => {
  const doc = knowledgeDocById(p.doc);
  const part = p.part ? doc?.parts.find((x) => x.id === p.part) : undefined;
  return doc ? (part ? `${doc.label} · ${part.short}` : doc.label) : p.doc;
};

/** A document and a rule are the same page under two collections: the address says which list it belongs to. */
const docScreens = (collection: 'documenti' | 'regole'): ScreenDef[] => { // allow-italian: address segments, compared by value
  const rules = collection === 'regole'; // allow-italian: address segment, compared by value
  const page = (id: string, path: string, pageId: DocPageId, samples: string[], withPart = false): ScreenDef => ({
    ...base,
    id,
    path,
    samples,
    tabKey: () => 'sarim:knowledge',
    tab: (p) => docTab(p),
    title: (p, ctx) => (pageId === 'text' ? docTitle(p) : `${ctx.copy.sarimData.knowledge.doc.pages[pageId]} · ${docTitle(p)}`),
    render: (p, ctx) => <DocScreen key={p.doc} ctx={ctx} docId={p.doc} partId={withPart ? p.part : undefined} page={pageId} />,
  });
  return [
    page('sarim-doc', `/conoscenza/${collection}/:doc`, 'text', rules
      ? world().samples.rules.map((doc) => SP.rule(doc))
      : world().samples.documents.map((doc) => SP.document(doc))),
    page('sarim-doc', `/conoscenza/${collection}/:doc/:part`, 'text', rules ? world().samples.ruleParts.map(([doc, part]) => SP.rule(doc, part)) : [], true),
    page('sarim-doc-versions', `/conoscenza/${collection}/:doc/versioni`, 'versions', rules ? world().samples.ruleVersions.map((doc) => SP.rulePage(doc, 'versions')) : world().samples.documentVersions.map((doc) => SP.documentPage(doc, 'versions'))), // allow-italian: address segment, not shown
    page('sarim-doc-usage', `/conoscenza/${collection}/:doc/dove-si-usa`, 'usage', rules ? world().samples.ruleUsage.map((doc) => SP.rulePage(doc, 'usage')) : world().samples.documentUsage.map((doc) => SP.documentPage(doc, 'usage'))), // allow-italian: address segment, not shown
  ];
};

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'sarim-knowledge',
    path: '/conoscenza/documenti', // allow-italian: address segment, not shown
    tabKey: () => 'sarim:knowledge',
    samples: [SP.documents()],
    title: (_p, ctx) => ctx.copy.sarimData.section.documents,
    render: (_p, ctx) => <HomeScreen ctx={ctx} section="documents" />,
  },
  {
    ...base,
    id: 'sarim-rules',
    path: '/conoscenza/regole', // allow-italian: address segment, not shown
    tabKey: () => 'sarim:knowledge',
    samples: [SP.rules()],
    title: (_p, ctx) => ctx.copy.sarimData.section.rules,
    render: (_p, ctx) => <HomeScreen ctx={ctx} section="rules" />,
  },
  ...docScreens('documenti'), // allow-italian: address segment, compared by value
  ...docScreens('regole'), // allow-italian: address segment, compared by value
];

export const SARIM_KNOWLEDGE_AREA: AreaModule = {
  screens: SCREENS,
};
