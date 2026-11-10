/**
 * From the example cases (`fixtures/org/cases`, plus what the reader changed,
 * `store/cases.ts`) to the view models the work screens draw: the queue, the
 * review of one input, the origin of a value, the record, the full sheet, the
 * day. Every case of the list goes through the same functions, so every case
 * opens fully and the numbers on every screen come from the same place.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { RichTextModel, StatusModel } from '../../../../ui/types';
import type { InboxModel, QueueItemModel, ReviewModel, ValueOriginModel, ClassificationFieldModel, OfficeOptionModel } from '../../../../ui/inbox/model';
import type { DraftBlockModel, PhaseModel, RecordModel, ReceiptModel } from '../../../../ui/record/model';
import type { DocPointModel, DocFieldModel } from '../../../../ui/work/DocSummary';
import type { CaseDeadline, CaseDocument, CaseField, CaseSeed } from '../../../../ui/fixtures/org/types';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { CHANNEL_LABEL, HUMAN_ALWAYS, channelAttachments, OFFICE_ORDER, SECTOR_WORK, recordName } from '../../../../ui/fixtures/work';
import type { LiveCase } from '../../store/cases';
import { caseSeed } from '../../store/cases';
import { P } from '../../paths';
import { ageLabel, daysFromToday, formatShortDay, hm, historyAt } from './format';

/** Where a case opens: SARIM's cases live under their own organization. */
export const recordPathOf = (c: { id: string; org: string }) => (c.org === 'sarim' ? P.sarimRecord(c.id) : P.record(c.id));

/* ---------- deadlines ---------- */

/**
 * The deadline that is the case's own term: the first of its list (the seeds
 * put the term first and the reminders around it after it).
 */
export const mainDeadline = (c: CaseSeed): CaseDeadline | undefined => c.deadlines[0];

/** Whether time is up on an input: it is urgent, or one of its dates has passed. */
export const isOverdue = (c: CaseSeed): boolean => Boolean(c.urgent) || c.deadlines.some((d) => daysFromToday(d.date) < 0);

/* ---------- the queue ---------- */

const FIELD_SURE = 85;

function tagOf(c: LiveCase, copy: UiCopy): StatusModel | undefined {
  const always = HUMAN_ALWAYS[c.kind];
  if (always) return { text: copy.work.inbox.alwaysPerson(always), tone: 'amber' };
  const weakest = c.fields.reduce<CaseField | undefined>((w, f) => (!w || f.confidence < w.confidence ? f : w), undefined);
  if (weakest && weakest.confidence < FIELD_SURE) return { text: copy.work.inbox.confidence(weakest.confidence), tone: 'amber' };
  return undefined;
}

export function queueItemOf(c: LiveCase, copy: UiCopy, now: string): QueueItemModel {
  return {
    id: c.id,
    title: c.title,
    proposal: c.proposal,
    when: c.urgent ? copy.work.inbox.dueNow : ageLabel(c.arrivedAt, now, copy),
    urgent: Boolean(c.urgent) || undefined,
    tag: tagOf(c, copy),
    officeId: c.office,
  };
}

export interface QueueFilters {
  filter: 'all' | 'overdue';
  office: string;
  query: string;
}

/** The queue as the person sees it after the filters; the counts are over the whole queue. */
export function inboxOf(queue: LiveCase[], filters: QueueFilters, selectedId: string | undefined, review: ReviewModel | undefined, copy: UiCopy, now: string): { inbox: InboxModel; offices: OfficeOptionModel[]; shown: LiveCase[] } {
  const q = filters.query.trim().toLowerCase();
  const shown = queue.filter((c) => (
    (filters.filter === 'all' || isOverdue(c))
    && (filters.office === 'all' || c.office === filters.office)
    && (!q || `${c.title} ${c.proposal} ${c.subject} ${c.counterpart} ${c.id}`.toLowerCase().includes(q))
  ));
  const offices = OFFICE_ORDER
    .map((o) => ({ id: o, label: OFFICE_LABEL[o], count: queue.filter((c) => c.office === o).length }))
    .filter((o) => o.count > 0);
  return {
    shown,
    offices,
    inbox: {
      items: shown.map((c) => queueItemOf(c, copy, now)),
      selectedId,
      counts: { all: queue.length, overdue: queue.filter(isOverdue).length },
      review,
    },
  };
}

/* ---------- the review of one input ---------- */

/** The document the summary of an input is read from: the main original, not the delivery receipt. */
export function mainDocument(c: CaseSeed): CaseDocument | undefined {
  return c.documents.find((d) => !d.draft && d.summary.length > 1) ?? c.documents.find((d) => !d.draft) ?? c.documents[0];
}

export function summaryOf(c: CaseSeed): RichTextModel {
  const doc = mainDocument(c);
  if (!doc) return [];
  const out: RichTextModel = [];
  doc.summary.forEach((p, i) => {
    out.push(i === 0 ? p.text : ` ${p.text}`);
    out.push({ source: { id: doc.id, label: i === 0 ? doc.name : undefined, page: p.page } });
  });
  return out;
}

export function fieldsOf(c: LiveCase): ClassificationFieldModel[] {
  return c.fields.map((f) => {
    const typed = c.live.values?.[f.id];
    const seed = caseSeed(c.id)?.fields.find((x) => x.id === f.id);
    const corrected = typed !== undefined && typed !== seed?.value;
    return { id: f.id, label: f.label, value: f.value, confidence: typed !== undefined ? undefined : f.confidence, corrected, confirmed: typed !== undefined && !corrected };
  });
}

export function reviewOf(c: LiveCase, copy: UiCopy, now: string): ReviewModel {
  const labels = c.steps.filter((s) => s.state === 'todo').map((s) => s.label);
  const dates = c.deadlines.map((d) => `${d.label} ${formatShortDay(d.date)}`);
  const deadline = mainDeadline(c);
  // The queue row says «scade ora» for an urgent input: the detail says the same, and the real term goes under it.
  const urgentNote = c.urgent && deadline ? copy.work.inbox.dueNowNote(deadline.label, formatShortDay(deadline.date)) : undefined;
  void now;
  return {
    kind: { text: SECTOR_WORK.reviewKind, tone: 'amber' },
    origin: copy.work.inbox.originLine(CHANNEL_LABEL[c.channel], hm(c.arrivedAt), c.counterpart, channelAttachments(c)),
    deadline: c.urgent ? copy.work.inbox.dueNow : deadline ? copy.work.inbox.dueOn(formatShortDay(deadline.date)) : undefined,
    deadlineNote: urgentNote,
    title: c.subject,
    summary: summaryOf(c),
    fields: fieldsOf(c),
    after: copy.work.inbox.afterConfirm(labels, dates),
    confirmLabel: SECTOR_WORK.confirmLabel,
    record: { id: c.id, label: recordName(c.id) },
  };
}

export function originOf(c: LiveCase, fieldId: string): ValueOriginModel | undefined {
  const f = c.fields.find((x) => x.id === fieldId);
  if (!f) return undefined;
  const seed = caseSeed(c.id)?.fields.find((x) => x.id === fieldId) ?? f;
  const doc = c.documents.find((d) => d.id === seed.source.doc);
  return {
    value: seed.value,
    source: { id: seed.source.doc, label: doc?.name, page: seed.source.page },
    before: seed.source.before ? `… ${seed.source.before}` : '',
    highlight: seed.source.highlight,
    after: seed.source.after ? `${seed.source.after} …` : '',
    reasoning: seed.reasoning,
    shortValue: seed.short ?? seed.value,
    consulted: seed.consulted,
  };
}

/* ---------- the record ---------- */

export const FLOW_NAME = (flow: string) => FLOWS.find((f) => f.id === flow)?.name;

export function phasesOf(c: LiveCase, copy: UiCopy): PhaseModel[] {
  return c.steps.map((s) => {
    const due = c.deadlines.find((d) => d.id === s.id);
    return {
      id: s.id,
      label: s.label,
      state: s.state,
      step: s.flowStep,
      date: s.at ? formatShortDay(s.at.slice(0, 10)) : due ? copy.work.record.byDate(formatShortDay(due.date)) : undefined,
    };
  });
}

/** The encoding of the paragraphs the reader adds to the draft: kept in `CaseLive.draftAdded` as JSON lines. */
export interface AddedBlock {
  text: string;
  bold?: boolean;
  italic?: boolean;
  bullet?: boolean;
  /** Written by the AI and still waiting for the reader's decision. */
  proposal?: boolean;
}

export const encodeAdded = (b: AddedBlock) => JSON.stringify(b);

export function decodeAdded(raw: string): AddedBlock {
  try {
    const v = JSON.parse(raw) as AddedBlock;
    if (v && typeof v.text === 'string') return v;
  } catch {
    /* an entry written as plain text */
  }
  return { text: raw };
}

/**
 * The draft with the reader's decisions applied: an accepted proposal joins
 * the text, a discarded one leaves it. `slots` tells, for each block shown,
 * where its decision is stored: a block of the seed (`seed`, its index) or a
 * paragraph the reader added or the AI proposed (`added`, its index).
 */
export type BlockSlot = { from: 'seed' | 'added'; index: number };

export function draftOf(c: LiveCase): { blocks: DraftBlockModel[]; slots: BlockSlot[] } | undefined {
  const draft = c.draft;
  if (!draft) return undefined;
  const blocks: DraftBlockModel[] = [];
  const slots: BlockSlot[] = [];
  draft.blocks.forEach((b, i) => {
    if (b.kind !== 'proposal') {
      blocks.push(b);
      slots.push({ from: 'seed', index: i });
      return;
    }
    const d = c.live.proposals?.[String(i)];
    if (d === 'discard') return;
    blocks.push(d === 'accept' ? { kind: 'paragraph', text: [b.text] } : b);
    slots.push({ from: 'seed', index: i });
  });
  (c.live.draftAdded ?? []).forEach((raw, i) => {
    const a = decodeAdded(raw);
    blocks.push(a.proposal
      ? { kind: 'proposal', text: a.text }
      : { kind: 'paragraph', text: a.bold ? [{ strong: a.text }] : [a.text], italic: a.italic, bullet: a.bullet });
    slots.push({ from: 'added', index: i });
  });
  return { blocks, slots };
}

export function receiptsOf(c: LiveCase): ReceiptModel[] {
  return (c.live.receipts ?? []).map((r, i) => ({ id: `rc-${i}`, title: r.title, at: historyAt(r.at), lines: r.lines })).reverse();
}

/** The chat of the assistant: the seed's turns, then what was asked since (answers are stored as JSON). */
export function turnsOf(c: LiveCase): Array<{ role: 'user' | 'assistant'; text: RichTextModel }> {
  const seeded = c.assistant?.turns ?? [];
  const added = (c.live.chat ?? []).map((t) => {
    if (t.role === 'user') return { role: t.role, text: [t.text] as RichTextModel };
    try {
      return { role: t.role, text: JSON.parse(t.text) as RichTextModel };
    } catch {
      return { role: t.role, text: [t.text] as RichTextModel };
    }
  });
  return [...seeded, ...added];
}

export function recordOf(c: LiveCase, copy: UiCopy): RecordModel {
  const main = mainDeadline(c);
  const related = (c.related ?? []).map((id) => caseSeed(id)).filter((x): x is CaseSeed => Boolean(x));
  const draft = draftOf(c);
  const doneChecks = c.live.checklist ?? {};
  const receipts = receiptsOf(c);
  const ran = receipts.length > 0;
  const checklist = (c.assistant?.checklist ?? []).map((x) => ({ id: x.id, text: x.text, done: doneChecks[x.id] ?? x.done }));
  return {
    crumbs: [{ label: SECTOR_WORK.myRecords }, { label: `${c.id} · ${c.title}` }],
    deadline: main ? copy.work.record.dueShort(formatShortDay(main.date)) : copy.work.record.noDeadline,
    exampleTag: SECTOR_WORK.exampleTag,
    primaryAction: ran ? copy.work.record.receiptButton : c.primaryAction.label,
    phasesLabel: copy.work.record.stepsOf(FLOW_NAME(c.flow) ?? ''),
    phases: phasesOf(c, copy),
    documents: c.documents.map((d) => ({
      id: d.id,
      name: d.name,
      detail: d.detail,
      badge: d.draft ? 'draft' : d.signed ? 'signed' : undefined,
      selected: Boolean(d.draft),
    })),
    related: {
      label: SECTOR_WORK.relatedLabel,
      items: related.map((r) => ({ id: r.id, title: `${r.title}`, detail: `${recordName(r.id)} · ${copy.work.record.statusOf[r.status]}` })),
    },
    draft: {
      file: c.draft?.file ?? '',
      meta: c.draft?.meta ?? '',
      blocks: draft?.blocks ?? [],
    },
    assistant: {
      tag: SECTOR_WORK.assistantTag,
      description: c.assistant?.description ?? SECTOR_WORK.assistantDescription,
      turns: turnsOf(c),
      checklistLabel: copy.work.record.checklist,
      checklistProgress: copy.work.record.checklistProgress(checklist.filter((x) => x.done).length, checklist.length),
      checklist,
      suggestions: copy.work.record.suggestions,
    },
    receipts,
    receiptsLabel: copy.work.record.receipts,
  };
}

/* ---------- originals ---------- */

export const pointsOf = (doc: CaseDocument): DocPointModel[] => doc.summary.map((p, i) => ({
  id: String(i),
  text: p.text,
  page: p.page,
  sourceLabel: `p.${p.page}`,
}));

/** The values read from one document, each with the page it was read on. */
export function docFieldsOf(c: LiveCase, doc: CaseDocument, copy: UiCopy): DocFieldModel[] {
  return c.fields
    .filter((f) => f.source.doc === doc.id)
    .map((f) => ({ id: f.id, label: f.label, value: f.value, sourceLabel: copy.common.page(f.source.page) }));
}
