import type { CrumbModel, RichTextModel } from '../types';

export type PhaseState = 'done' | 'current' | 'todo';

/** One stage of a record's life, as its type defines it. */
export interface PhaseModel {
  id: string;
  label: string;
  date?: string;
  state: PhaseState;
  /** The step of the record's flow that brings it to this stage, when there is one. */
  step?: string;
}

export interface DocumentModel {
  id: string;
  name: string;
  detail: string;
  badge?: 'signed' | 'draft';
  selected?: boolean;
}

/** A block of the draft in the editor. */
export type DraftBlockModel =
  | { kind: 'heading'; lines: string[] }
  | { kind: 'paragraph'; lead?: string; text: RichTextModel; muted?: boolean; italic?: boolean; bullet?: boolean }
  | { kind: 'proposal'; text: string };

/** What an action that left the system returned: the PEC receipt, the filing, the payment. */
export interface ReceiptModel {
  id: string;
  title: string;
  /** When, already formatted. */
  at: string;
  lines: string[];
}

export interface ChatTurnModel {
  role: 'user' | 'assistant';
  text: RichTextModel;
}

export interface ChecklistItemModel {
  id: string;
  text: string;
  done: boolean;
}

export interface RecordModel {
  crumbs: CrumbModel[];
  deadline: string;
  exampleTag?: string;
  primaryAction: string;
  phasesLabel: string;
  phases: PhaseModel[];
  documents: DocumentModel[];
  related: { label: string; items: Array<{ id: string; title: string; detail: string }> };
  draft: { file: string; meta: string; blocks: DraftBlockModel[] };
  assistant: {
    tag: string;
    description: string;
    turns: ChatTurnModel[];
    checklistLabel: string;
    /** Done over total (1 of 5), next to the label, so a closed list still tells where the work stands. */
    checklistProgress?: string;
    checklist: ChecklistItemModel[];
    /** Questions the assistant can answer from the record, offered as chips. */
    suggestions?: string[];
  };
  /** Receipts of what already left the system, newest first. */
  receipts?: ReceiptModel[];
  receiptsLabel?: string;
}

export type RecordSection = 'documents' | 'data' | 'history';
