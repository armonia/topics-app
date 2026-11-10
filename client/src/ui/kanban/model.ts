/**
 * The view models of «Da fare» (allow-italian: quotes the Italian interface): the list of cards by flow,
 * the kanban whose columns are the stages of the work, the table of flows
 * against stages, and the page of one card with its originals. Cards say who
 * has them in hand (a person or an agent) and who must check them. Plain data:
 * the wiring fills them, these components only draw them.
 */
import type { LucideIcon } from 'lucide-react';
import type { Tone } from '../types';

/** The glyph a stage wears, the same family as the Board's columns. */
export type StageGlyph = 'incoming' | 'working' | 'check' | 'approve' | 'done';

/** A small coloured word on a card: a flow, a priority, a date, a state. */
export interface TagModel {
  text: string;
  tone: Tone;
  /** The longer sentence on hover. */
  title?: string;
}

/** Who has a card in hand now: a person (monogram and colour) or an agent (the bot glyph). */
export interface WorkerModel {
  kind: 'person' | 'agent';
  /** The short name on a card: «Avv. Bruno», «Agente fatture». (allow-italian: quotes the Italian interface) */
  name: string;
  /** The full name, for the tooltip. */
  fullName: string;
  monogram?: string;
  color?: string;
  /** What it is doing, in plain words. */
  doing: string;
  /** How long it has had it, already formatted: «da 12 min». (allow-italian: quotes the Italian interface) */
  since: string;
  /** An agent at work right now: its glyph pulses. */
  active?: boolean;
}

/** A column a card can be moved to, with why not when it cannot. */
export interface MoveOptionModel {
  id: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

/** A flow named on a card: its icon (by area) and its short name, never a colour. */
export interface FlowRefModel {
  label: string;
  icon: LucideIcon;
  /** The longer sentence on hover. */
  title?: string;
}

export interface KanbanCardModel {
  id: string;
  title: string;
  /** The place, the supplier, the amount: one line. */
  detail: string;
  /** The flow it belongs to, on every card. */
  flow: FlowRefModel;
  priority?: TagModel;
  due?: TagModel;
  /** Stopped on something outside it: the badge and the reason under it. */
  blocked?: { text: string; reason: string; title: string };
  /** Left in its column longer than its flow allows. */
  stuck?: TagModel;
  /** The step of the flow it is at, in words; empty when the card already says it (the reason, the task). */
  step: string;
  worker: WorkerModel;
  /** «verifica: Avv. Bruno», already formatted; empty when it is the person at work. (allow-italian: quotes the Italian interface) */
  reviewer: string;
  moveTo: MoveOptionModel[];
  /** Set: the person cannot move this card (drag or menu), and this says why. */
  moveDisabledTitle?: string;
}

export interface KanbanColumnModel {
  id: string;
  label: string;
  /** What being here means: the tooltip of the column title, not a line of its own. */
  hint: string;
  /** The line under the title: real numbers of the column (average wait, how many stopped), already formatted. */
  facts?: string;
  glyph: StageGlyph;
  cards: KanbanCardModel[];
  /** In the view of one stage the others fold to a narrow strip that opens them. */
  folded?: boolean;
  /** Where the work piles up: a quiet amber note in the header. */
  piles?: boolean;
}

/** One choice of a picker (a view), with its count. */
export interface ChoiceModel {
  id: string;
  label: string;
  count?: number;
  tone?: Tone;
  title?: string;
}

/* ---------- the table per stage ---------- */

/** The parts of the share bar: who closed the cards in «Fatto». (allow-italian: quotes the Italian interface) */
export interface ShareModel {
  agent: number;
  person: number;
  agentLabel: string;
  personLabel: string;
}

/** One stage of one flow: how many cards, how long they wait, how many are stopped. */
export interface StageCellModel {
  stage: string;
  count: number;
  /** «attesa media 13 h 44», already formatted; empty for a stage with no wait or no card. (allow-italian: quotes the Italian interface) */
  wait: string;
  stuck: number;
  stuckLabel: string;
  /** The open stage where the work of this row piles up. */
  piles: boolean;
  pilesLabel: string;
  /** The sentence that says why it piles up. */
  pilesWhy?: string;
  /** The accessible name of the cell when it can be pressed. */
  label: string;
}

/** A flow (or all of them together) against the stages. */
export interface FlowRowModel {
  /** The flow id, `undefined` for the row of all flows. */
  flow?: string;
  label: string;
  icon: LucideIcon;
  /** Under the name: the agent that prepares it and when it counts as stopped. */
  sub: string;
  cells: StageCellModel[];
  stuck: number;
  stuckLabel: string;
  stuckOpenLabel: string;
  share: ShareModel;
  openLabel: string;
}

/** A stage as a column of the table. */
export interface StageColumnModel {
  id: string;
  label: string;
  hint: string;
  glyph: StageGlyph;
}

/* ---------- the list ---------- */

/** One card in the list of its flow. */
export interface CardRowModel {
  id: string;
  title: string;
  /** The comune or committente, when there is one. */
  place?: string;
  stage: { label: string; glyph: StageGlyph };
  worker: WorkerModel;
  due?: TagModel;
  /** How long it has been in its stage (amber past the limit of its flow, red when blocked); none on a closed card. */
  inStage?: TagModel;
}

/** The cards of one flow under a header that folds them. */
export interface CardGroupModel {
  /** The flow id. */
  id: string;
  label: string;
  icon: LucideIcon;
  open: boolean;
  total: number;
  stuck: number;
  waiting: number;
  rows: CardRowModel[];
}

/* ---------- the card page ---------- */

/** An original the card carries, with the lines as written on it. */
export interface OriginalModel {
  id: string;
  name: string;
  kind: 'mail' | 'photo' | 'screen' | 'form' | 'invoice' | 'tender' | 'sheet' | 'letter' | 'call';
  kindLabel: string;
  /** «mail AMA · 06/11 10:13», already formatted. (allow-italian: quotes the Italian interface) */
  from: string;
  lines: string[];
  /** The picture of a photo or a screen, when the original has one. */
  image?: string;
}

/** A passage to mark on an original: the words a value was read from. */
export interface QuoteMarkModel {
  /** The value it belongs to (its label). */
  id: string;
  quote: string;
  /** The value, for the tooltip of the mark. */
  label: string;
}
