/**
 * What «Conoscenza» of ORBIT knows besides the fixture: which procedures a (allow-italian: quotes the Italian interface)
 * person approved, which ones an agent rewrote on request, which questions
 * were asked. On top of that, the pieces every place of the area shares: the
 * live text of a document (its versions and the state of a procedure), the
 * labels and addresses of what a part rests on, what cites a document, and
 * the question box, which answers only with parts of the documents and says
 * so when none of them does.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { AnswerModel, PassageModel, UsageGroupModel, VersionModel } from '../../../../ui/knowledge/model';
import type { RichTextModel, Tone } from '../../../../ui/types';
import { knowledgeDocById, world } from '../../world';
import type { KnowledgeDoc, KnowledgePart, KnowledgeQuestion } from '../../../../ui/fixtures/orbit-org/knowledge';
import type { Contract, OrbitCard } from '../../../../ui/fixtures/orbit-org/types';
import type { ScreenCtx } from '../../../app/kit';
import type { DemoState } from '../../../app/store/state';
import { liveCards, liveContracts, stageOf } from '../../model/live';
import { opsFlowById } from '../../model/flows';
import { nameOf, stageLabel } from '../../model/words';
import { SP } from '../../paths';

/* ---------- the slice ---------- */

export const KNOWLEDGE_SLICE = 'orbit.knowledge';

export interface KnowledgeRewrite {
  /** The number the version gets: after the ones of the fixture. */
  n: number;
  at: string;
  /** Who asked for it (a persona id). */
  by: string;
  note: string;
}

export interface KnowledgeSlice {
  /** Procedure id → the version a person approved, when and who. */
  approved: Record<string, { at: string; by: string; version: string }>;
  /** Procedure id → the versions an agent wrote on request, oldest first. */
  rewrites: Record<string, KnowledgeRewrite[]>;
  /** The questions asked, newest first. */
  asked: Array<{ question: string; at: string; by: string; doc?: string }>;
}

export const KNOWLEDGE_INITIAL: KnowledgeSlice = { approved: {}, rewrites: {}, asked: [] };

/* ---------- the live document ---------- */

export interface LiveDoc {
  doc: KnowledgeDoc;
  /** Newest first, with the version in use marked `current`. */
  versions: VersionModel[];
  /** The status chip of the header. */
  status: { text: string; tone: Tone };
  /** For a procedure: whether its newest version waits for a person. */
  draft: boolean;
  /** The version the flows follow, when one is approved. */
  inUse?: string;
  /** The newest version. */
  latest: string;
  /** Who approved the version in use and when (`YYYY-MM-DD`), when the reader did it here. */
  approval?: { at: string; by: string };
}

const STATUS_TONE: Record<'green' | 'amber' | 'neutral', Tone> = { green: 'green', amber: 'amber', neutral: 'neutral' };

/**
 * A document as it is now. A law or a company paper is the fixture; a
 * procedure adds the versions an agent rewrote and the approval a person gave:
 * the approved version is the one in use, the newer ones wait, the older ones
 * are replaced.
 */
export function liveDoc(doc: KnowledgeDoc, slice: KnowledgeSlice, copy: UiCopy): LiveDoc {
  const plain = (): LiveDoc => ({
    doc,
    versions: doc.versions.map((v) => ({ id: v.id, label: v.label, detail: v.detail, status: { text: v.status.text, tone: STATUS_TONE[v.status.tone] }, current: v.current })),
    status: { text: doc.status.text, tone: STATUS_TONE[doc.status.tone] },
    draft: false,
    latest: doc.versions[0]?.id ?? '',
  });
  const proc = doc.procedure;
  if (!proc) return plain();
  const k = copy.orbitData.knowledge;
  const base = doc.versions;
  const added = (slice.rewrites[doc.id] ?? []).map((r) => ({
    id: `v${r.n}`,
    label: k.changes.versionLabel(r.n),
    detail: k.changes.versionDetail(nameOf(proc.writtenBy), r.note),
  }));
  const all = [...[...added].reverse(), ...base.map((v) => ({ id: v.id, label: v.label, detail: v.detail }))];
  const given = slice.approved[doc.id];
  const inUse = given?.version ?? (proc.state === 'approved' ? base.find((v) => v.current)?.id : undefined);
  const usedAt = inUse ? all.findIndex((v) => v.id === inUse) : -1;
  const versions: VersionModel[] = all.map((v, i) => {
    let status: { text: string; tone: Tone };
    if (v.id === inUse) status = { text: k.versions.approved, tone: 'green' };
    else if (usedAt === -1 ? i === 0 : i < usedAt) status = { text: k.versions.toApprove, tone: 'amber' };
    else status = { text: k.versions.replaced, tone: 'neutral' };
    return { id: v.id, label: v.label, detail: v.detail, status, current: usedAt === -1 ? i === 0 : v.id === inUse };
  });
  const latest = all[0]?.id ?? '';
  const draft = inUse !== latest;
  return {
    doc: {
      ...doc,
      procedure: {
        ...proc,
        state: draft ? 'draft' : 'approved',
        approver: given?.by ?? proc.approver,
        approvedAt: given ? given.at.slice(0, 10) : proc.approvedAt,
      },
    },
    versions,
    status: draft ? { text: k.doc.procedure.draft, tone: 'amber' } : { text: k.doc.procedure.approved, tone: 'green' },
    draft,
    inUse,
    latest,
    approval: given ? { at: given.at.slice(0, 10), by: given.by } : undefined,
  };
}

export function liveDocs(slice: KnowledgeSlice, copy: UiCopy): LiveDoc[] {
  return world().knowledge.docs.map((d) => liveDoc(d, slice, copy));
}

/** Procedures waiting for a person, newest version first. */
export function draftsOf(docs: LiveDoc[]): LiveDoc[] {
  return docs.filter((d) => d.draft);
}

/* ---------- references ---------- */

function contractOf(contracts: Contract[], id: string): Contract | undefined {
  return contracts.find((c) => c.id === id);
}

/** The number a clause is printed with, looked up in the newest version that has it. */
function clauseNumber(contract: Contract | undefined, clause: string): string {
  if (contract) {
    for (const v of [...contract.versions].sort((a, b) => b.n - a.n)) {
      const found = v.clauses.find((c) => c.id === clause);
      if (found) return found.n;
    }
  }
  return clause.replace(/^art-/, '');
}

/** The two halves of a reference `<doc>/<part>` or `contract:<id>/<clause>`: the document or contract, and the part or clause when there is one. */
export function refParts(ref: string, contracts: Contract[], copy: UiCopy): { head: string; part?: string } {
  if (ref.startsWith('contract:')) {
    const [id, clause] = ref.slice(9).split('/');
    const contract = contractOf(contracts, id);
    return { head: contract?.title ?? id, part: copy.orbitData.common.clause(clauseNumber(contract, clause)) };
  }
  const [docId, partId] = ref.split('/');
  const doc = knowledgeDocById(docId);
  const part = doc?.parts.find((p) => p.id === partId);
  return doc ? { head: doc.label, part: part?.short } : { head: ref };
}

/** `D.Lgs. 36/2023 · Art. 120 c. 3` or `Smart Leaf · art. 6` for a reference `<doc>/<part>` or `contract:<id>/<clause>`. */
export function refLabel(ref: string, contracts: Contract[], copy: UiCopy): string {
  const { head, part } = refParts(ref, contracts, copy);
  return part ? `${head} · ${part}` : head;
}

/**
 * Where an answer comes from, each document named once: one document with its
 * parts (`D.Lgs. 36/2023 · Art. 120 c. 3, Art. 120 c. 9`), several by their
 * names only. Joined label by label, the same document came back twice.
 */
export function sourcesLine(refs: string[], contracts: Contract[], copy: UiCopy): string {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    const { head, part } = refParts(ref, contracts, copy);
    const parts = groups.get(head) ?? [];
    if (part && !parts.includes(part)) parts.push(part);
    groups.set(head, parts);
  }
  const list = [...groups.entries()];
  if (list.length === 1) {
    const [head, parts] = list[0];
    return parts.length ? `${head} · ${parts.join(', ')}` : head;
  }
  return list.map(([head]) => head).join(' · ');
}

/** Where a reference opens: the part of the document, or the clause of the contract. */
export function refPath(ref: string): string {
  if (ref.startsWith('contract:')) {
    const [id, clause] = ref.slice(9).split('/');
    return clause ? SP.clause(id, clause) : SP.contract(id);
  }
  const [docId, partId] = ref.split('/');
  return SP.knowledgeDoc(docId, partId || undefined);
}

/** A row id of a usage list carries the address, then `#` and the part, so one card may cite two parts. */
export const usagePath = (rowId: string) => rowId.split('#')[0];

/* ---------- what cites a document ---------- */

export interface UsageRow {
  id: string;
  title: string;
  detail: string;
  part: string;
}

function card(cards: OrbitCard[], id: string): OrbitCard | undefined {
  return cards.find((c) => c.id === id);
}

/** The procedure steps that rest on a part: `<procedure>/<step>`. */
function stepsResting(docId: string, partId: string): Array<{ doc: KnowledgeDoc; part: KnowledgePart }> {
  const ref = `${docId}/${partId}`;
  const out: Array<{ doc: KnowledgeDoc; part: KnowledgePart }> = [];
  for (const doc of world().knowledge.docs) {
    if (doc.collection !== 'procedure') continue;
    for (const part of doc.parts) if (part.rests?.includes(ref)) out.push({ doc, part });
  }
  return out;
}

/** How many cards, flow steps, clauses and procedure steps cite a part. */
export function citedCount(doc: KnowledgeDoc, part: KnowledgePart): number {
  return (part.citedBy?.length ?? 0) + stepsResting(doc.id, part.id).length;
}

/** What cites one part of a document, by kind. */
function partUsage(doc: KnowledgeDoc, part: KnowledgePart, cards: OrbitCard[], contracts: Contract[], copy: UiCopy): Record<'cards' | 'flows' | 'contracts' | 'procedures', UsageRow[]> {
  const k = copy.orbitData.knowledge.doc;
  const out: Record<'cards' | 'flows' | 'contracts' | 'procedures', UsageRow[]> = { cards: [], flows: [], contracts: [], procedures: [] };
  for (const c of part.citedBy ?? []) {
    if (c.kind === 'card') {
      const found = card(cards, c.id);
      if (!found) continue;
      out.cards.push({ id: `${SP.card(found.id)}#${part.id}`, title: `${found.id} · ${found.title}`, detail: `${part.short} · ${k.usageCard(stageLabel(stageOf(found)), c.why)}`, part: part.id });
    } else if (c.kind === 'flow') {
      const flow = opsFlowById(c.id);
      if (!flow) continue;
      const step = c.at ? flow.steps.find((s) => s.id === c.at) : undefined;
      out.flows.push({
        id: `${step ? SP.flowStep(flow.id, step.id) : SP.flow(flow.id)}#${part.id}`,
        title: flow.name,
        detail: `${part.short} · ${step ? k.usageFlow(step.title, c.why) : c.why}`,
        part: part.id,
      });
    } else {
      const contract = contractOf(contracts, c.id);
      if (!contract) continue;
      out.contracts.push({
        id: `${c.at ? SP.clause(contract.id, c.at) : SP.contract(contract.id)}#${part.id}`,
        title: contract.title,
        detail: `${part.short} · ${c.at ? k.usageClause(copy.orbitData.common.clause(clauseNumber(contract, c.at)), c.why) : c.why}`,
        part: part.id,
      });
    }
  }
  for (const s of stepsResting(doc.id, part.id)) {
    out.procedures.push({ id: `${SP.knowledgeDoc(s.doc.id, s.part.id)}#${part.id}`, title: s.doc.label, detail: `${part.short} · ${k.usageStep(s.part.heading)}`, part: part.id });
  }
  return out;
}

/** What cites a document, grouped as the «Usato da» tab shows it. (allow-italian: quotes the Italian interface) */
export function usageOf(doc: KnowledgeDoc, state: DemoState, copy: UiCopy): UsageGroupModel[] {
  const cards = liveCards(state);
  const contracts = liveContracts(state);
  const groups: Record<'cards' | 'flows' | 'contracts' | 'procedures', UsageRow[]> = { cards: [], flows: [], contracts: [], procedures: [] };
  for (const part of doc.parts) {
    const u = partUsage(doc, part, cards, contracts, copy);
    for (const g of ['cards', 'flows', 'contracts', 'procedures'] as const) groups[g].push(...u[g]);
  }
  const labels = copy.orbitData.knowledge.doc.usage;
  return (['cards', 'flows', 'contracts', 'procedures'] as const).map((g) => ({
    id: g,
    label: labels[g],
    rows: groups[g].map(({ id, title, detail }) => ({ id, title, detail })),
  }));
}

/** What cites one part, as the side panel lists it. */
export function usedByPart(doc: KnowledgeDoc, part: KnowledgePart, state: DemoState, copy: UiCopy): Array<{ id: string; title: string; detail: string }> {
  const u = partUsage(doc, part, liveCards(state), liveContracts(state), copy);
  return [...u.flows, ...u.cards, ...u.contracts, ...u.procedures].map(({ id, title, detail }) => ({ id, title, detail }));
}

/* ---------- the question box ---------- */

const STOP_WORDS = new Set([
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'uno', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'ed', 'ma', 'che', 'chi', 'cosa', 'come', 'dove', // allow-italian: words the question box skips
  'quando', 'quanto', 'quanti', 'quante', 'quale', 'quali', 'sono', 'ha', 'hanno', 'deve', 'devono', 'puo', 'possono', 'del', 'dello', 'della', 'dei', 'degli', // allow-italian: words the question box skips
  'delle', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle', 'sul', // allow-italian: words the question box skips
  'sullo', 'sulla', 'sui', 'sugli', 'sulle', 'non', 'si', 'se', 'piu', 'mi', 'ci', 'ne', 'anche', 'poi', 'suo', 'sua', 'suoi', 'sue', 'questo', 'questa', 'questi', // allow-italian: words the question box skips
  'queste', 'quello', 'quella', 'essere', 'fare', 'dell', 'all', 'nell', 'sull', 'dall', 'ogni', 'dopo', 'prima', 'sia', 'era', 'ho', 'abbiamo', 'serve', 'servono', // allow-italian: words the question box skips
  'art', 'comma', 'the', 'of', 'to', 'and', 'is', 'can', 'how', 'what', 'who', 'when', 'does', 'do', // allow-italian: words the question box skips
  world().words.slug,
]);

/** The words of a text that carry meaning, cut to five letters so «formulario» and «formulari» meet. (allow-italian: quotes the Italian interface) */
export function stems(text: string): string[] {
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    out.add(w.length > 5 ? w.slice(0, 5) : w);
  }
  return [...out];
}

interface Passage {
  ref: string;
  doc: KnowledgeDoc;
  part: KnowledgePart;
  /** The words shown: the official passage when there is one, then what it means. */
  shown: string;
  words: Set<string>;
}

/**
 * Every part the box may answer from. A procedure waiting for approval is
 * left out: the agents do not follow it yet, so the box does not quote it.
 */
function corpus(docs: LiveDoc[]): Passage[] {
  const out: Passage[] = [];
  for (const d of docs) {
    if (d.draft) continue;
    for (const part of d.doc.parts) {
      const shown = part.quote ? `«${part.quote}». ${part.summary}` : part.summary;
      out.push({
        ref: `${d.doc.id}/${part.id}`,
        doc: d.doc,
        part,
        shown,
        words: new Set(stems(`${d.doc.label} ${part.heading} ${part.quote ?? ''} ${part.summary} ${part.keywords ?? ''} ${d.doc.keywords ?? ''}`)),
      });
    }
  }
  return out;
}

/** The sentence of a passage that holds most of the question's words, with those words marked. */
function excerptOf(text: string, asked: Set<string>): RichTextModel {
  const sentences = text.split(/(?<=[.;:»])\s+/).filter(Boolean);
  let best = sentences[0] ?? text;
  let bestHits = -1;
  for (const s of sentences) {
    const hits = stems(s).filter((w) => asked.has(w)).length;
    if (hits > bestHits) {
      best = s;
      bestHits = hits;
    }
  }
  const clip = best.length > 280 ? `${best.slice(0, 277).replace(/\s+\S*$/, '')}…` : best;
  return markWords(clip, asked);
}

function markWords(text: string, asked: Set<string>): RichTextModel {
  const out: RichTextModel = [];
  let plain = '';
  for (const piece of text.split(/(\s+)/)) {
    const hit = piece.trim() !== '' && stems(piece).some((w) => asked.has(w));
    if (hit) {
      if (plain) out.push(plain);
      plain = '';
      out.push({ mark: piece });
    } else plain += piece;
  }
  if (plain) out.push(plain);
  return out;
}

/** The plain words of a rich text, for a summary that quotes a passage. */
const plainOf = (t: RichTextModel) => t.map((x) => (typeof x === 'string' ? x : 'mark' in x ? x.mark : 'strong' in x ? x.strong : '')).join('');

/**
 * Answers a question only from the parts of the documents. A question close
 * to one people ask often (most of its words in the asked one) gets the
 * answer written for it, each sentence with its part; any other question gets
 * the parts that hold at least two of its words (rarer words weigh more, the
 * document on show weighs more), quoted, at most two per document. When no
 * part matches it says so and invents nothing.
 */
export function ask(question: string, docs: LiveDoc[], contracts: Contract[], copy: UiCopy, preferDoc?: string): AnswerModel {
  const none: AnswerModel = { question, status: 'none', summary: [], passages: [] };
  const q = stems(question);
  if (!q.length) return none;
  const asked = new Set(q);
  const all = corpus(docs);
  const byRef = new Map(all.map((p) => [p.ref, p]));
  const passages: PassageModel[] = [];
  const numbers = new Map<string, number>();
  const add = (p: Passage): number => {
    const known = numbers.get(p.ref);
    if (known) return known;
    const n = passages.length + 1;
    numbers.set(p.ref, n);
    passages.push({ n, label: `${p.doc.label} · ${p.part.short}`, excerpt: excerptOf(p.shown, asked), sourceId: p.ref });
    return n;
  };
  const chip = (p: Passage, n: number) => ({ source: { id: p.ref, label: `${n} · ${refLabel(p.ref, contracts, copy)}` } });

  /* a question people ask often */
  let known: KnowledgeQuestion | undefined;
  let bestScore = 0;
  for (const candidate of world().knowledge.questions) {
    const words = stems(candidate.question);
    if (!words.length) continue;
    const hits = words.filter((w) => asked.has(w)).length;
    const score = hits / words.length;
    if (hits >= 2 && score >= 0.6 && score > bestScore) {
      known = candidate;
      bestScore = score;
    }
  }
  if (known) {
    const usable = known.answer.filter((a) => byRef.has(a.source));
    if (usable.length) {
      const summary: RichTextModel = [];
      usable.forEach((a, i) => {
        const p = byRef.get(a.source) as Passage;
        summary.push(i ? ` ${a.text} ` : `${a.text} `);
        summary.push(chip(p, add(p)));
      });
      return { question, status: 'found', summary, passages };
    }
  }

  /* any other question: the parts that hold its words */
  const holders = new Map<string, number>();
  for (const p of all) for (const w of asked) if (p.words.has(w)) holders.set(w, (holders.get(w) ?? 0) + 1);
  const need = Math.min(2, q.length);
  const scored = all
    .map((p) => {
      const hit = q.filter((w) => p.words.has(w));
      const weight = p.doc.id === preferDoc ? 1.6 : 1;
      return { p, hits: hit.length, score: hit.reduce((sum, w) => sum + Math.log(1 + all.length / (holders.get(w) ?? 1)), 0) * weight };
    })
    .filter((r) => r.hits >= need)
    .sort((a, b) => b.score - a.score || a.p.ref.localeCompare(b.p.ref));
  const perDoc = new Map<string, number>();
  const picked = scored.filter((r) => {
    const n = perDoc.get(r.p.doc.id) ?? 0;
    if (n >= 2) return false;
    perDoc.set(r.p.doc.id, n + 1);
    return true;
  }).slice(0, 3);
  if (!picked.length) return none;
  const summary: RichTextModel = [];
  picked.forEach((r, i) => {
    const n = add(r.p);
    summary.push(`${i ? ' ' : ''}${plainOf(excerptOf(r.p.part.summary, asked))} `);
    summary.push(chip(r.p, n));
  });
  return { question, status: 'found', summary, passages };
}

/** The questions the box suggests: the ones people ask often, first those about the document on show. */
export function suggestionsFor(docId?: string): string[] {
  const all = world().knowledge.questions;
  if (!docId) return all.slice(0, 4).map((x) => x.question);
  const about = all.filter((x) => x.answer.some((a) => a.source.startsWith(`${docId}/`)));
  return [...about, ...all.filter((x) => !about.includes(x))].slice(0, 3).map((x) => x.question);
}

/** The copy the shared question box and answer read, with ORBIT's words in place of the generic ones. */
export function askCopy(copy: UiCopy, placeholder: string): UiCopy {
  const s = copy.orbitData.knowledge.ask;
  return {
    ...copy,
    knowledgeMore: {
      ...copy.knowledgeMore,
      collections: { ...copy.knowledgeMore.collections, askPlaceholder: placeholder, answerShared: s.shared, noSourceBody: s.noSourceBody },
    },
    preview: { ...copy.preview, noUsage: s.noUsage },
  };
}

/** Records a question in the slice (newest first, no doubles) and in the log. */
export function recordQuestion(ctx: ScreenCtx, question: string, doc?: KnowledgeDoc) {
  const [, setSlice] = ctx.slice<KnowledgeSlice>(KNOWLEDGE_SLICE, KNOWLEDGE_INITIAL);
  setSlice((s) => ({
    ...s,
    asked: [{ question, at: ctx.now, by: ctx.persona.id, doc: doc?.id }, ...(s.asked ?? []).filter((x) => x.question !== question)].slice(0, 12),
  }));
  ctx.log(ctx.copy.orbitData.knowledge.ask.log(question), 'knowledge', doc ? SP.knowledgeDoc(doc.id) : SP.knowledge());
}

export { openExternal } from '../../external';

/** The host of a link, for a line of facts. */
export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

/* ---------- what the lists filter by ---------- */

/** When each fixed document was last updated, read from its own note (a procedure carries its own dates). */
/** The day a document was last updated, `YYYY-MM-DD`. */
export function updatedOf(doc: KnowledgeDoc): string {
  const proc = doc.procedure;
  return (proc ? proc.approvedAt ?? proc.writtenAt : world().knowledge.updated[doc.id]) ?? '';
}

/** The flows that use a document: those that follow a procedure, those a part checks, those that cite a part. */
export function flowsOf(doc: KnowledgeDoc): string[] {
  const ids = new Set<string>(doc.procedure?.flows ?? []);
  for (const part of doc.parts) {
    for (const c of part.checks ?? []) if (c.flow) ids.add(c.flow);
    for (const c of part.citedBy ?? []) if (c.kind === 'flow') ids.add(c.id);
  }
  return [...ids];
}
