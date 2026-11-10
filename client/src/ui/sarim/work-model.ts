/**
 * The view models of the SARIM edition's «Flussi»: what the flows (allow-italian: quotes the Italian interface)
 * need to draw themselves, already worded and counted
 * by the caller. Plain data and callbacks, nothing about where it comes from.
 */
import type { LucideIcon } from 'lucide-react';
import type { Action, FieldRef, StatusModel, Tone } from '../types';

/** Who does a step or holds a card: a rule, an agent of Topics, a program, a person of the organization. */
export type WorkActorModel =
  | { kind: 'rule'; label: string }
  | { kind: 'agent'; name: string }
  | { kind: 'program'; name: string }
  | { kind: 'person'; name: string; monogram?: string; color?: string }
  | { kind: 'action'; name: string };

/** A card of the kanban as a small link: its id, its title, and whether it is stopped. */
export interface CardLinkModel {
  id: string;
  title: string;
  /** The tooltip: where it stands, who has it. */
  hint?: string;
  stopped?: boolean;
  onOpen: () => void;
}

/* ---------- «Flussi» ---------- (allow-italian: quotes the Italian interface) */

/** Where a flow stands: the glyph of its chip comes from this, the words and the tint from `StatusModel`. */
export type FlowState = 'active' | 'testing' | 'draft' | 'paused';

export interface FlowStatusModel extends StatusModel {
  state: FlowState;
}

export interface FlowRowModel {
  id: string;
  name: string;
  /** The icon of the flow, the same on every screen. */
  icon?: LucideIcon;
  /** What the flow produces, a quiet line under the name when the flow has one. */
  outcome?: string;
  /** `versione 2 · 7 passi`. (allow-italian: quotes the Italian interface) */
  meta: string;
  status: FlowStatusModel;
  paused: boolean;
  area: string;
  trigger: string;
  perMonth: string;
  programs: string[];
  /** `2 di 7 passi`. (allow-italian: quotes the Italian interface) */
  agents: string;
  /** The live cards at each step, in order; `n` is the number the flow page gives the step, `hint` names it. */
  steps: Array<{ id: string; n: string; count: number; hint: string; /** The closing step: cards already done, shown apart from the work still open. */ done?: boolean }>;
  open: string;
  stuck?: string;
  onOpen: () => void;
}

export interface FlowStatModel {
  id: string;
  label: string;
  value: number;
  detail: string;
  tone?: Tone;
}

export interface FlowJobModel {
  label: string;
  detail?: string;
  value: number;
}

export interface FlowControlsModel {
  /** Opens «Da fare» with this flow on the filter. (allow-italian: quotes the Italian interface) */
  onOpenInDaFare: () => void;
  onTry: Action;
  tryTitle?: string;
  onPause: Action;
  pauseTitle?: string;
  paused: boolean;
}

/** One card at a step, on the step page: who has it, since when, who checks it. */
export interface StepCardModel {
  id: string;
  title: string;
  detail: string;
  worker: WorkActorModel;
  doing: string;
  since: string;
  reviewer: WorkActorModel;
  stopped?: string;
  onOpen: () => void;
}

export interface StepPageModel {
  id: string;
  flow: string;
  marker: string;
  title: string;
  stage: { label: string; hint: string };
  /** When a card at this step counts as stopped; none for the last column. */
  stops?: string;
  actor: WorkActorModel;
  does: string;
  reads: FieldRef[];
  produces: FieldRef[];
  cards: StepCardModel[];
  /** Only for a step an agent does: who checks what it did, the next person in the flow; `next` is missing when no person comes after. */
  after?: { next?: { actor: WorkActorModel; step: string; onOpen: () => void } };
  nav: Array<{ id: string; marker: string; title: string; actor: WorkActorModel; onOpen: () => void }>;
  onPrev?: () => void;
  onNext?: () => void;
  onBack: () => void;
  onColumn: () => void;
}
