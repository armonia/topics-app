/**
 * The logic of the knowledge area, free of React: the items (the fixtures plus
 * what the reader loaded), their articles with the pasted text applied, the
 * addresses a source or a norm opens, who cites a document, and the search
 * that answers a question only from passages of the documents.
 */
import type { RichTextModel } from '../../../../ui/types';
import type { AnswerModel, PassageModel } from '../../../../ui/knowledge/model';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import type { CaseSeed } from '../../../../ui/fixtures/org/types';
import {
  ITEMS, PROCEDURES, findArticle, itemById, plainText,
  type ArticleSeed, type CollectionId, type ItemSeed, type ProcedureSeed,
} from '../../../../ui/fixtures/knowledge-more';
import { CURATED_ANSWER, CURATED_SOURCES } from '../../../../ui/fixtures/knowledge-more-answers';
import { P } from '../../paths';
import type { DocsState, ProcedureLive, ProceduresState } from './state';
import { EMPTY_PROCEDURE } from './state';

/* ---------- time ---------- */

/** `06/11 10:30` from an ISO date-time with its offset. */
export function stamp(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

/** `06/11/2026` from an ISO day. */
export function day(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/* ---------- items ---------- */

/** A document the reader loaded, as an item: its paragraphs are its articles. */
function uploadItem(u: DocsState['uploads'][number]): ItemSeed {
  const paragraphs = u.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    id: u.id,
    collection: u.collection,
    label: u.title,
    title: u.title,
    status: { text: 'caricato', tone: 'green' }, // allow-italian: fixture data, shown as written
    officialSource: u.by,
    chips: paragraphs.slice(0, 6).map((_, i) => ({ id: `p${i + 1}`, label: `§ ${i + 1}`, articleId: `p${i + 1}` })),
    articles: paragraphs.map((text, i) => ({ id: `p${i + 1}`, group: `p${i + 1}`, heading: `§ ${i + 1}`, text: [text] })),
    facts: [
      { label: 'Caricato da', value: u.by }, // allow-italian: fixture data, shown as written
      { label: 'Data', value: stamp(u.at) }, // allow-italian: fixture data, shown as written
      { label: 'Paragrafi', value: String(paragraphs.length) }, // allow-italian: fixture data, shown as written
    ],
    ruleRows: [],
    versions: [{ id: `v-${u.id}`, label: u.title, detail: `Caricato da ${u.by} il ${stamp(u.at)}.`, status: { text: 'in uso', tone: 'green' }, current: true }], // allow-italian: fixture data, shown as written
    original: {
      heading: 'DOCUMENTO CARICATO', // allow-italian: fixture data, shown as written
      publication: [
        { label: 'Titolo', value: u.title }, // allow-italian: fixture data, shown as written
        { label: 'Caricato da', value: u.by }, // allow-italian: fixture data, shown as written
      ],
      paragraphs: paragraphs.map((text) => ({ text })),
    },
    refs: [],
    flowRefs: [],
  };
}

export function allItems(docs: DocsState): ItemSeed[] {
  return [...ITEMS, ...docs.uploads.map(uploadItem)];
}

export function getItem(docs: DocsState, id: string): ItemSeed | undefined {
  return itemById(id) ?? docs.uploads.filter((u) => u.id === id).map(uploadItem)[0];
}

/** The articles of an item, a pasted text taking the place of the missing one. */
export function articlesOf(item: ItemSeed, docs: DocsState): ArticleSeed[] {
  return item.articles.map((a) => {
    const pasted = docs.pasted[`${item.id}/${a.id}`];
    if (!pasted) return a;
    return { ...a, subject: undefined, text: [pasted.text], source: `incollato da ${pasted.by}` }; // allow-italian: fixture data, shown as written
  });
}

/** `Art. 10, comma 2` from `Art. 10, comma 2 · Autorità di Polizia Idraulica`. (allow-italian: quotes the Italian interface) */
export function articleShort(a: ArticleSeed): string {
  return a.heading.split(' · ')[0];
}

export function itemPath(item: string, article?: string): string {
  return P.knowledgeDoc(item, article);
}

/* ---------- sources ---------- */

/** Where a source token opens: `k:<item>/<article>`, `p:<procedure>`, `c:<case>/<doc>`. */
export function sourcePath(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const [kind, rest] = [id.slice(0, 1), id.slice(2)];
  if (kind === 'k') {
    const [item, article] = rest.split('/');
    return P.knowledgeDoc(item, article);
  }
  if (kind === 'p') return P.procedure(rest);
  if (kind === 'c') {
    const [caseId, doc] = rest.split('/');
    return doc ? P.recordDoc(caseId, doc) : P.record(caseId);
  }
  return undefined;
}

/** The token a norm `<item>/<article>` opens. */
export const normToken = (norm: string) => `k:${norm}`;

/** `L.R. Campania 7/2025 · Art. 10, comma 2` for a norm id, whatever its loaded state. */
export function normLabel(docs: DocsState, norm: string): string {
  const [itemId, articleId] = norm.split('/');
  const item = getItem(docs, itemId);
  if (!item) return norm;
  const article = findArticle(item, articleId);
  return article ? `${item.label} · ${articleShort(article)}` : item.label;
}

/* ---------- who cites what ---------- */

export interface CaseCitation {
  seed: CaseSeed;
  /** The article the case cites, as it wrote it. */
  article: string;
}

/** Cases whose `norms` cite the item, optionally one article of it. */
export function citingCases(itemId: string, item?: ItemSeed, article?: ArticleSeed): CaseCitation[] {
  const out: CaseCitation[] = [];
  for (const seed of CASES) {
    for (const n of seed.norms ?? []) {
      const [i, a] = n.split('/');
      if (i !== itemId) continue;
      if (article && item) {
        const cited = findArticle(item, a);
        if (cited?.id !== article.id) continue;
      }
      out.push({ seed, article: a ?? '' });
    }
  }
  return out;
}

export function liveProcedure(state: ProceduresState, id: string): ProcedureLive {
  return state[id] ?? EMPTY_PROCEDURE;
}

export function procedureSteps(seed: ProcedureSeed, live: ProcedureLive) {
  return live.steps ?? seed.steps;
}

export function procedureStatus(seed: ProcedureSeed, live: ProcedureLive) {
  return live.status ?? seed.status;
}

/** Procedures that rest on an item, by the norms of their steps and base. */
export function citingProcedures(itemId: string, article?: ArticleSeed, item?: ItemSeed): ProcedureSeed[] {
  return PROCEDURES.filter((p) => {
    const norms = [...p.steps.map((s) => s.norm), ...p.base.map((b) => b.norm)].filter((n): n is string => !!n);
    return norms.some((n) => {
      const [i, a] = n.split('/');
      if (i !== itemId) return false;
      if (!article || !item) return true;
      return findArticle(item, a)?.id === article.id;
    });
  });
}

export interface FlowCitation {
  flowId: string;
  flowName: string;
  stepId: string;
  stepLabel: string;
  detail: string;
}

/** Flows and flow steps that cite an item, resolved against the example flows. */
export function citingFlows(item: ItemSeed): FlowCitation[] {
  const out: FlowCitation[] = [];
  for (const ref of item.flowRefs) {
    const flow = FLOWS.find((f) => f.id === ref.flow);
    if (!flow) continue;
    const step = (ref.step ? flow.steps.find((s) => s.label.toLowerCase().includes(ref.step ?? '')) : undefined) ?? flow.steps[0];
    out.push({ flowId: flow.id, flowName: flow.name, stepId: step?.id ?? '', stepLabel: step?.label ?? '', detail: ref.detail });
  }
  return out;
}

/** The flow a rule row opens: the flow when it exists, else a new one is suggested. */
export function ruleFlowPath(flowId: string | undefined): string {
  const flow = flowId ? FLOWS.find((f) => f.id === flowId) : undefined;
  return flow ? P.flow(flow.id) : P.flowNew();
}

/* ---------- search ---------- */

const STOP = new Set([
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'uno', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'ed', 'ma', 'che', 'chi', 'cosa', 'come', 'dove', // allow-italian: fixture data, shown as written
  'quando', 'quanto', 'quanti', 'quante', 'quale', 'quali', 'sono', 'ha', 'hanno', 'deve', 'devono', 'puo', 'possono', 'del', 'dello', 'della', 'dei', 'degli', // allow-italian: fixture data, shown as written
  'delle', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle', 'sul', // allow-italian: fixture data, shown as written
  'sullo', 'sulla', 'sui', 'sugli', 'sulle', 'non', 'si', 'se', 'piu', 'mi', 'ci', 'ne', 'anche', 'poi', 'suo', 'sua', 'suoi', 'sue', 'questo', 'questa', 'questi', // allow-italian: fixture data, shown as written
  'queste', 'quello', 'quella', 'essere', 'fare', 'dell', 'all', 'nell', 'sull', 'dall', 'entro', 'ogni', 'dopo', 'prima', 'sia', 'sono', 'era', 'ho', 'abbiamo', // allow-italian: fixture data, shown as written
]);

/** The words of a text that carry meaning, cut to five letters so «sanzione» and «sanzioni» meet. */
export function stems(text: string): string[] {
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(w.length > 5 ? w.slice(0, 5) : w);
  }
  return [...out];
}

export interface Passage {
  /** The source token it opens. */
  id: string;
  label: string;
  /** What the source chip prints before the page. */
  short: string;
  text: string;
  page?: number;
  weight: number;
}

/** Every passage the question box may answer from: articles, approved procedures, case documents, loaded documents. */
export function corpus(docs: DocsState, procs: ProceduresState): Passage[] {
  const out: Passage[] = [];
  for (const item of allItems(docs)) {
    for (const a of articlesOf(item, docs)) {
      const text = a.text ? plainText(a.text) : a.subject ?? '';
      if (!text) continue;
      out.push({ id: `k:${item.id}/${a.id}`, label: `${item.label} · ${articleShort(a)}`, short: item.label, text: `${a.heading}. ${text}`, page: a.page, weight: 1 });
    }
  }
  for (const p of PROCEDURES) {
    const live = liveProcedure(procs, p.id);
    if (procedureStatus(p, live) !== 'approvata') continue;
    for (const s of procedureSteps(p, live)) {
      out.push({ id: `p:${p.id}`, label: `Procedura · ${p.title}`, short: p.title, text: `${p.title}. ${s.text}`, weight: 0.9 }); // allow-italian: fixture data, shown as written
    }
  }
  for (const c of CASES) {
    for (const d of c.documents) {
      d.text.forEach((page, i) => {
        if (page) out.push({ id: `c:${c.id}/${d.id}`, label: `${c.id} · ${c.title} · ${d.name}`, short: `${c.id} · ${c.title}`, text: page, page: i + 1, weight: 0.6 }); // allow-italian: fixture data, shown as written
      });
    }
  }
  return out;
}

/** The sentence or two of a passage that holds most of the question's words, with those words marked. */
function excerptOf(text: string, qStems: Set<string>): RichTextModel {
  const sentences = text.split(/(?<=[.;:])\s+/).filter(Boolean);
  let best = sentences[0] ?? text;
  let bestScore = -1;
  for (const s of sentences) {
    const hits = stems(s).filter((w) => qStems.has(w)).length;
    if (hits > bestScore) {
      best = s;
      bestScore = hits;
    }
  }
  const clip = best.length > 280 ? `${best.slice(0, 277).replace(/\s+\S*$/, '')}…` : best;
  const parts: RichTextModel = [];
  let plain = '';
  let run = '';
  let gap = '';
  for (const piece of clip.split(/(\s+)/)) {
    if (/^\s+$/.test(piece) || piece === '') {
      if (run) gap += piece;
      else plain += piece;
      continue;
    }
    const hit = stems(piece).some((w) => qStems.has(w));
    if (hit) {
      if (run) run += gap + piece;
      else {
        if (plain) parts.push(plain);
        plain = '';
        run = piece;
      }
      gap = '';
    } else {
      if (run) {
        parts.push({ mark: run });
        run = '';
        plain = gap;
        gap = '';
      }
      plain += piece;
    }
  }
  if (run) parts.push({ mark: run });
  if (plain) parts.push(plain);
  return parts;
}

/**
 * Answers a question only from the passages of the documents. A passage counts
 * when it holds at least two of the question's words (one, for a one-word
 * question), rarer words weigh more, and the loaded norms outrank cases. The
 * answer is the best passages quoted, each with its number; when nothing
 * matches it says so and invents nothing.
 */
export function answerQuestion(question: string, docs: DocsState, procs: ProceduresState): AnswerModel {
  const all = corpus(docs, procs);
  const q = stems(question);
  const qSet = new Set(q);
  const none: AnswerModel = { question, status: 'none', summary: [], passages: [] };
  if (!q.length) return none;
  const df = new Map<string, number>();
  const sets = all.map((p) => new Set(stems(p.text)));
  for (const s of sets) for (const w of qSet) if (s.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const need = Math.min(2, q.length);
  const scored = all
    .map((p, i) => {
      const hit = q.filter((w) => sets[i].has(w));
      const score = hit.reduce((sum, w) => sum + Math.log(1 + all.length / (df.get(w) ?? 1)), 0) * p.weight;
      return { p, hit: hit.length, score };
    })
    .filter((r) => r.hit >= need)
    .sort((a, b) => b.score - a.score);
  const perSource = new Map<string, number>();
  const picked = scored.filter((r) => {
    const n = perSource.get(r.p.id) ?? 0;
    if (n >= 1) return false;
    perSource.set(r.p.id, n + 1);
    return true;
  }).slice(0, 4);
  if (!picked.length) return none;

  const curated = CURATED_ANSWER.stems.every((w) => qSet.has(w));
  const passages: PassageModel[] = [];
  const numberOf = new Map<string, number>();
  const add = (p: Passage): number => {
    const known = numberOf.get(p.id);
    if (known) return known;
    const n = passages.length + 1;
    numberOf.set(p.id, n);
    passages.push({ n, label: p.label, excerpt: excerptOf(p.text, qSet), sourceId: p.id });
    return n;
  };
  const chip = (p: Passage, n: number) => ({ source: { id: p.id, label: `${n} · ${p.short}`, page: p.page } });
  const summary: RichTextModel = [];
  if (curated) {
    const found = CURATED_SOURCES.map((id) => all.find((p) => p.id === id));
    if (found.every(Boolean)) {
      for (const part of CURATED_ANSWER.parts) {
        if (typeof part === 'string') summary.push(part);
        else {
          const p = found[part.n] as Passage;
          summary.push(chip(p, add(p)));
        }
      }
      for (const r of picked) add(r.p);
      return { question, status: 'found', summary, passages: passages.slice(0, 6) };
    }
  }
  picked.slice(0, 3).forEach((r, i) => {
    const n = add(r.p);
    summary.push(i ? ' «' : '«');
    summary.push(...excerptOf(r.p.text, qSet).map((x) => (typeof x === 'object' && 'mark' in x ? x.mark : x)));
    summary.push('» ');
    summary.push(chip(r.p, n));
  });
  for (const r of picked.slice(3)) add(r.p);
  return { question, status: 'found', summary, passages };
}

/** Which documents an answer rests on: the items its passages open. */
export function answerItems(answer: AnswerModel): Set<string> {
  const out = new Set<string>();
  for (const p of answer.passages) if (p.sourceId.startsWith('k:')) out.add(p.sourceId.slice(2).split('/')[0]);
  return out;
}

/** Every collection item as `{ id, collection }`, the loaded ones included. */
export function itemsInCollection(docs: DocsState, collection: CollectionId): ItemSeed[] {
  return allItems(docs).filter((i) => i.collection === collection);
}
