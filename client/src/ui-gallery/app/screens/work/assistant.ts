/**
 * The assistant of a record, as a small deterministic responder: it reads the
 * question for what is asked (a deadline, a document, a norm, who, how much,
 * where the record stands) and answers from the record's own data, always
 * citing the document and page or the norm it took each fact from. The same
 * question on the same record gives the same answer; what it cannot answer
 * it says, and lists what it can.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { RichTextModel, SourceModel } from '../../../../ui/types';
import { KNOWLEDGE_ALIAS, normLabel } from '../../../../ui/fixtures/work';
import type { LiveCase } from '../../store/cases';
import { caseSeed } from '../../store/cases';
import { P } from '../../paths';
import { daysFromToday, distanceLabel, formatAmount, formatDay } from './format';
import { mainDocument } from './adapters';

type Intent = 'deadline' | 'documents' | 'who' | 'amount' | 'norms' | 'related' | 'status' | 'signature' | 'help';

const ORDER: Intent[] = ['deadline', 'signature', 'documents', 'amount', 'norms', 'related', 'status', 'who', 'help'];

function intentOf(question: string, copy: UiCopy): Intent | undefined {
  const q = question.toLowerCase();
  const kw = copy.work.assistant.keywords;
  return ORDER.find((i) => kw[i].some((w) => q.includes(w)));
}

/** A citation of one page of a document of the case. */
const cite = (docId: string, label: string, page: number): { source: SourceModel } => ({ source: { id: docId, label, page } });

/** The document a deadline runs from: the one received on its start day. */
function startDocument(c: LiveCase, from: string) {
  return c.documents.find((d) => d.receivedAt?.slice(0, 10) === from) ?? mainDocument(c);
}

export function answer(question: string, c: LiveCase, copy: UiCopy): RichTextModel {
  const a = copy.work.assistant;
  const intent = intentOf(question, copy);
  const main = mainDocument(c);
  const out: RichTextModel = [];
  switch (intent) {
    case 'deadline': {
      if (c.deadlines.length === 0) return [a.noDeadlines];
      out.push(a.deadlinesIntro(c.deadlines.length));
      c.deadlines.forEach((d) => {
        out.push(' ', { strong: formatDay(d.date) });
        out.push(a.deadlineLine(d.label, distanceLabel(daysFromToday(d.date), copy), d.rule, d.calc));
        const doc = startDocument(c, d.from);
        if (doc) out.push(cite(doc.id, doc.name, doc.summary[0]?.page ?? 1));
      });
      return out;
    }
    case 'signature': {
      const signed = c.documents.filter((d) => d.signed);
      if (signed.length === 0) return [a.noSigned];
      out.push(a.signedIntro(signed.length));
      signed.forEach((d) => out.push(cite(d.id, d.name, 1)));
      return out;
    }
    case 'documents': {
      out.push(a.documentsIntro(c.documents.length));
      c.documents.forEach((d) => {
        out.push(' ', { strong: d.name }, a.documentDetail(d.detail), cite(d.id, d.name, d.summary[0]?.page ?? 1));
      });
      return out;
    }
    case 'amount': {
      const withAmount = c.fields.filter((f) => f.value.includes('€'));
      if (c.amount === undefined && withAmount.length === 0) return [a.noAmount];
      if (c.amount !== undefined) out.push(a.amountIs(formatAmount(c.amount)));
      withAmount.forEach((f) => {
        const doc = c.documents.find((d) => d.id === f.source.doc);
        out.push(' ', { strong: f.label }, a.fieldValue(f.value));
        if (doc) out.push(cite(doc.id, doc.name, f.source.page));
      });
      return out;
    }
    case 'norms': {
      const norms = c.norms ?? [];
      if (norms.length === 0) return [a.noNorms];
      out.push(a.normsIntro(norms.length));
      norms.forEach((n) => out.push(' ', { source: { id: n, label: normLabel(n) } }));
      return out;
    }
    case 'related': {
      const related = (c.related ?? []).map((id) => caseSeed(id)).filter((x) => x !== undefined);
      if (related.length === 0) return [a.noRelated];
      out.push(a.relatedIntro(related.length));
      related.forEach((r) => out.push(' ', { source: { id: `case:${r!.id}`, label: `${r!.id} · ${r!.title}` } }));
      return out;
    }
    case 'status': {
      const current = c.steps.find((s) => s.state === 'current');
      const next = c.steps.find((s) => s.state === 'todo');
      out.push(a.statusLine(current?.label ?? '', next?.label, copy.work.record.statusOf[c.status]));
      if (main) out.push(cite(main.id, main.name, main.summary[0]?.page ?? 1));
      return out;
    }
    case 'who': {
      out.push(a.whoLine(c.counterpart, c.comune));
      if (main) out.push(cite(main.id, main.name, 1));
      return out;
    }
    default: {
      out.push(a.overview(c.title, c.subject));
      if (main) out.push(cite(main.id, main.name, main.summary[0]?.page ?? 1));
      out.push(' ', a.canAnswer);
      return out;
    }
  }
}

/** Where a citation of an answer, a draft or a field leads, and the page to turn to. */
export function sourcePath(c: LiveCase, s: SourceModel): { path: string; doc?: string; page?: number } {
  const id = s.id;
  if (!id) return { path: P.recordSheet(c.id) };
  if (id.startsWith('case:')) return { path: P.record(id.slice(5)) };
  const doc = c.documents.find((d) => d.id === id || d.name === s.label);
  if (doc) return { path: P.recordDoc(c.id, doc.id), doc: doc.id, page: s.page };
  const alias = KNOWLEDGE_ALIAS[id];
  if (alias) return { path: P.knowledgeDoc(alias[0], alias[1]) };
  if (id.startsWith('r-')) {
    const rel = caseSeed(id.slice(2)) ?? (c.related ?? []).map((r) => caseSeed(r)).find(Boolean);
    return { path: rel ? P.record(rel.id) : P.recordSheet(c.id) };
  }
  if (id.includes('/')) {
    const [item, article] = id.split('/');
    return { path: P.knowledgeDoc(item, article) };
  }
  return { path: P.recordSheet(c.id) };
}
