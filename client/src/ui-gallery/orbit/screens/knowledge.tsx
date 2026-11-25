/**
 * ORBIT edition, area «Conoscenza», its two lists of documents: the company's own
 * papers («Documenti») and the laws and procedures the agents follow
 * («Regole»), each split in parts that cards, flow steps and contract clauses
 * cite. A document has three pages (text, versions, where it is used), each at
 * its own address. Contracts and data are the other two sections
 * (`contracts.tsx`, `data.tsx`). The words are in
 * `ctx.copy.orbitData.knowledge`, the documents in
 * `fixtures/orbit-org/knowledge.ts`, what the reader changed (approvals,
 * rewrites, questions) in the `orbit.knowledge` slice.
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
    tabKey: () => 'orbit:knowledge',
    tab: (p) => docTab(p),
    title: (p, ctx) => (pageId === 'text' ? docTitle(p) : `${ctx.copy.orbitData.knowledge.doc.pages[pageId]} · ${docTitle(p)}`),
    render: (p, ctx) => <DocScreen key={p.doc} ctx={ctx} docId={p.doc} partId={withPart ? p.part : undefined} page={pageId} />,
  });
  return [
    page('orbit-doc', `/conoscenza/${collection}/:doc`, 'text', rules
      ? world().samples.rules.map((doc) => SP.rule(doc))
      : world().samples.documents.map((doc) => SP.document(doc))),
    page('orbit-doc', `/conoscenza/${collection}/:doc/:part`, 'text', rules ? world().samples.ruleParts.map(([doc, part]) => SP.rule(doc, part)) : [], true),
    page('orbit-doc-versions', `/conoscenza/${collection}/:doc/versioni`, 'versions', rules ? world().samples.ruleVersions.map((doc) => SP.rulePage(doc, 'versions')) : world().samples.documentVersions.map((doc) => SP.documentPage(doc, 'versions'))), // allow-italian: address segment, not shown
    page('orbit-doc-usage', `/conoscenza/${collection}/:doc/dove-si-usa`, 'usage', rules ? world().samples.ruleUsage.map((doc) => SP.rulePage(doc, 'usage')) : world().samples.documentUsage.map((doc) => SP.documentPage(doc, 'usage'))), // allow-italian: address segment, not shown
  ];
};

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'orbit-knowledge',
    path: '/conoscenza/documenti', // allow-italian: address segment, not shown
    tabKey: () => 'orbit:knowledge',
    samples: [SP.documents()],
    title: (_p, ctx) => ctx.copy.orbitData.section.documents,
    render: (_p, ctx) => <HomeScreen ctx={ctx} section="documents" />,
  },
  {
    ...base,
    id: 'orbit-rules',
    path: '/conoscenza/regole', // allow-italian: address segment, not shown
    tabKey: () => 'orbit:knowledge',
    samples: [SP.rules()],
    title: (_p, ctx) => ctx.copy.orbitData.section.rules,
    render: (_p, ctx) => <HomeScreen ctx={ctx} section="rules" />,
  },
  ...docScreens('documenti'), // allow-italian: address segment, compared by value
  ...docScreens('regole'), // allow-italian: address segment, compared by value
];

export const ORBIT_KNOWLEDGE_AREA: AreaModule = {
  screens: SCREENS,
};
