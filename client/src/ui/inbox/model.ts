import type { RichTextModel, SourceModel, StatusModel } from '../types';

/** One input waiting for a person, as the queue lists it. */
export interface QueueItemModel {
  id: string;
  title: string;
  /** What the AI proposes, in one line (office, deadline). */
  proposal: string;
  /** Right of the title: how old it is, or that its time is up. */
  when: string;
  urgent?: boolean;
  tag?: StatusModel;
  /** The office it is proposed to, for the office filter and the phone row. */
  officeId?: string;
}

/** A proposed value a person confirms or corrects. */
export interface ClassificationFieldModel {
  id: string;
  label: string;
  value: string;
  /** 0-100; under 85 it reads amber. */
  confidence?: number;
  corrected?: boolean;
  /** The field's value was confirmed as it stands (no percentage any more). */
  confirmed?: boolean;
}

/** Where a value comes from: the original's words around it, and the rule applied. */
export interface ValueOriginModel {
  value: string;
  source: SourceModel;
  before: string;
  highlight: string;
  after: string;
  reasoning: RichTextModel;
  /** The short form of the value for the button that applies it. */
  shortValue: string;
  consulted: number;
}

export interface ReviewModel {
  kind: StatusModel;
  origin: string;
  deadline?: string;
  /** One line under the header that explains the deadline, when the header alone would mislead. */
  deadlineNote?: string;
  title: string;
  summary: RichTextModel;
  fields: ClassificationFieldModel[];
  /** What happens on its own after the confirmation, in one paragraph. */
  after: string;
  /** The words of the confirmation, from the sector package. */
  confirmLabel: string;
  /** The record the flow already opened for this input, e.g. `Pratica 2418`. */
  record?: { id: string; label: string };
}

/** What the office filter of the queue offers: an office, how many inputs wait for it. */
export interface OfficeOptionModel {
  id: string;
  label: string;
  count: number;
}

export interface InboxModel {
  items: QueueItemModel[];
  selectedId?: string;
  counts: { all: number; overdue: number };
  /** The input on show; absent when nothing is selected. */
  review?: ReviewModel;
}

export type QueueFilter = 'all' | 'overdue';
