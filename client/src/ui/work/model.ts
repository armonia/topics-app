import type { Tone } from '../types';
import type { PhaseModel } from '../record/model';

/** One thing that waits for the person today, as a card of «La mia giornata» (x05). */
export interface TodayTaskModel {
  id: string;
  /** `urgent` outlines the card in red; `procedure` is the AI-written text waiting for review. */
  tone: 'urgent' | 'todo' | 'plain' | 'procedure';
  chips: Array<{ text: string; tone: Tone }>;
  title: string;
  detail: string;
  action: string;
  /** The first card's action is the primary one. */
  primary?: boolean;
}

export interface DeadlineRowModel {
  id: string;
  /** `30/11 · memorie`. */
  label: string;
  /** `25 gg`, `oggi`, `scaduta da 2 gg`. */
  distance: string;
  tone: 'urgent' | 'soon' | 'later';
  /** Which record it belongs to, as a quiet second line. */
  detail?: string;
}

export interface DeadlineGroupModel {
  id: string;
  label: string;
  items: DeadlineRowModel[];
}

export interface ActivityRowModel {
  id: string;
  text: string;
  when: string;
  /** Whether the line leads somewhere. */
  linked: boolean;
}

export interface AgendaRowModel {
  id: string;
  time: string;
  label: string;
  detail: string;
}

export interface TodayModel {
  dateLabel: string;
  headline: string;
  tasks: TodayTaskModel[];
  deadlineGroups: DeadlineGroupModel[];
  recent: ActivityRowModel[];
  agenda: AgendaRowModel[];
  doneYesterday: Array<{ id: string; label: string; value: number }>;
}

/** A key facts card of the full sheet (w05): a label, a big line, a quiet line. */
export interface SheetFactModel {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone?: 'urgent';
  /** Where it leads, when it leads anywhere. */
  linked?: boolean;
}

export interface SheetFieldModel {
  id: string;
  label: string;
  value: string;
  /** Where it was read from, `ricorso.pdf.p7m · p.5`. */
  source: string;
  confidence: string;
  corrected?: boolean;
}

export interface SheetDeadlineModel {
  id: string;
  label: string;
  date: string;
  distance: string;
  tone: 'urgent' | 'soon' | 'later';
  /** `60 giorni dal 05/11/2026`. (allow-italian: quotes the Italian interface) */
  calc: string;
  rule: string;
  rollsOver?: string;
}

export interface SheetHistoryModel {
  id: string;
  at: string;
  who: string;
  what: string;
  /** The kind of actor, for the little chip: flow, AI, person, program. */
  kind: 'flow' | 'ai' | 'person' | 'program' | 'receipt';
  kindLabel: string;
  /** In the future: a step still to come. */
  pending?: boolean;
  linked?: boolean;
}

export interface SheetDocumentModel {
  id: string;
  name: string;
  badge?: { text: string; tone: Tone };
  detail: string;
}

export interface SheetModel {
  crumbs: Array<{ label: string }>;
  kindLabel: string;
  title: string;
  exampleTag: string;
  facts: SheetFactModel[];
  fields: SheetFieldModel[];
  deadlines: SheetDeadlineModel[];
  history: SheetHistoryModel[];
  documents: SheetDocumentModel[];
  related: Array<{ id: string; title: string; detail: string }>;
  phasesLabel: string;
  phases: PhaseModel[];
  whoLabel: string;
  who: { headline: string; detail: string; rows: Array<{ id: string; label: string; value: string }> };
  systems: Array<{ id: string; what: string; where: string }>;
  primaryLabel: string;
  /** The program that holds the protocol: the one «open in» leads to. */
  programName: string;
}
