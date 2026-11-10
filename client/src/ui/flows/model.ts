import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CrumbModel, FieldKind, FieldRef, StatusModel, Tone } from '../types';

/** Who does a step: what starts the flow, a fixed rule, the AI, a person or a program. */
export type ActorKind = 'trigger' | 'rule' | 'ai' | 'person' | 'program' | 'action';

export interface ActorModel {
  kind: ActorKind;
  /** The program's name (Halley, Prunes), or the name of an agent (`ai`); without it a kind takes the product's word. */
  name?: string;
  tone?: Tone;
}

/** One step of a flow, in order: who, what, what it reads and what it writes. */
export interface FlowStepModel {
  id: string;
  /** What the timeline prints beside it: `1`, `a`; none for the trigger. */
  marker?: string;
  actors: ActorModel[];
  title: string;
  /** The rule of thumb of the step, quiet on the right. */
  note?: string;
  uses?: FieldRef[];
  produces?: FieldRef[];
  /** The view the step opens for whoever has to act on it. */
  opens?: string;
  /** The time a person has, e.g. `entro 4 h`. */
  due?: string;
  /** Where the step ends up, e.g. `card in Board`. */
  trailing?: string;
  /** The step the side panel is describing. */
  highlighted?: boolean;
}

/** One path after the branch: a type of input and the steps it takes. */
export interface FlowPathModel {
  id: string;
  letter: string;
  kind: FieldKind;
  title: string;
  hint?: string;
  badge?: StatusModel;
  meta: string;
  expanded?: boolean;
  steps?: FlowStepModel[];
}

export interface CollectedRowModel {
  field?: FieldRef;
  label: string;
  /** The type of the value, printed small (`data e ora`). */
  hint?: string;
  value: string;
}

export interface CollectedSectionModel {
  label: string;
  rows: CollectedRowModel[];
}

/** What a path collects, step by step, and who may read it. */
export interface CollectedDataModel {
  tag: string;
  title: string;
  description: string;
  sections: CollectedSectionModel[];
  access: { label: string; value: string };
}

export interface FlowModel {
  crumbs: CrumbModel[];
  status: StatusModel;
  trigger: FlowStepModel;
  steps: FlowStepModel[];
  /** The paths by type of input; a flow that does not split has none. */
  branch?: { marker: string; count: number; paths: FlowPathModel[] };
  collected: CollectedDataModel;
}

export type FlowView = 'steps' | 'byOffice' | 'runs' | 'tests' | 'versions' | 'log';

/** The container of a step: the steps every input takes, or one path. */
export const MAIN_CONTAINER = 'main';

/**
 * What a flow page needs to let a person change its steps: open one, add one
 * after another (`afterId` null = first in the container), and the menu of a
 * step (move, remove). `disabledTitle` set: the person may not, and why.
 */
export interface StepEditing {
  addLabel: string;
  disabledTitle?: string;
  onOpen: (stepId: string) => void;
  onAdd: (container: string, afterId: string | null) => void;
  menu: (container: string, stepId: string) => ReactNode;
}

/* ---------- the one drawing of a flow (FlowCanvas) ---------- */

/** How the one drawing of a flow is used: changed (the flow page), read (from a card) or followed (one run). */
export type CanvasMode = 'edit' | 'read' | 'run';

/** Where a step stands for the case on show: read and run only; a step without a state is just a step. */
export type CanvasStepState = 'done' | 'current' | 'error' | 'waiting' | 'next';

/** Who does a step: a rule, an agent, a program, a person (with an avatar when the person is known) or an action. */
export type CanvasActor =
  | { kind: 'rule'; label: string }
  | { kind: 'agent'; name: string }
  | { kind: 'program'; name: string }
  | { kind: 'person'; name: string; monogram?: string; color?: string }
  | { kind: 'action'; name: string };

/** An original a step produced or read, as a link to open beside the flow. */
export interface CanvasOriginal {
  id: string;
  name: string;
  /** Already formatted: «PEC · 05/11 09:12». (allow-italian: quotes the Italian interface) */
  meta: string;
  icon: LucideIcon;
  onOpen: () => void;
}

/** One step, the same card wherever the flow is drawn. */
export interface CanvasStep {
  id: string;
  /** What the rail prints: `1`, `a`. */
  marker?: string;
  actors: CanvasActor[];
  title: string;
  /** The rule of thumb of the step, quiet beside the title. */
  note?: string;
  uses?: FieldRef[];
  produces?: FieldRef[];
  /** The view the step opens for whoever acts on it. */
  opens?: string;
  /** The time a person has, «entro 4 h». (allow-italian: quotes the Italian interface) */
  due?: string;
  /** The column of «Da fare» a case at this step stands in. (allow-italian: quotes the Italian interface) */
  stage?: string;
  /** Small chips after the title: «3 tentativi», «nuovo». (allow-italian: quotes the Italian interface) */
  badges?: Array<{ label: string; tone: Tone }>;
  /** Read and run: where the step stands for the case on show. */
  state?: CanvasStepState;
  /** The words on the current or stopped step: «La card è qui», «Fermo qui». (allow-italian: quotes the Italian interface) */
  flag?: string;
  /** A step done: who and when, already worded. */
  done?: string;
  /** The current step: who has the case there now. */
  here?: ReactNode;
  originals?: CanvasOriginal[];
  /** The flow page: the cases standing at the step right now. */
  cards?: ReactNode;
}

/** One case after a split: what makes it this case, and the steps it takes before the cases meet again. */
export interface CanvasLane {
  id: string;
  letter: string;
  kind: FieldKind;
  title: string;
  hint?: string;
  badge?: StatusModel;
  /** Volume and office, quiet: «540 al mese · Call center». (allow-italian: quotes the Italian interface) */
  meta?: string;
  steps: CanvasStep[];
  /** The case hands over to another flow: «avvia «Fattura passiva»». (allow-italian: quotes the Italian interface) */
  handoff?: string;
  /** Read and run: the case on show takes this lane; the others are drawn quieter. */
  taken?: boolean;
}

/** A place in the column of a flow: a step, or a split into cases side by side that meet again under it. */
export type CanvasNode =
  | { kind: 'step'; step: CanvasStep }
  | {
      kind: 'split';
      id: string;
      marker?: string;
      /** What decides the case: «tipo di segnalazione». (allow-italian: quotes the Italian interface) */
      by: string;
      lanes: CanvasLane[];
      /** Read and run: the case on show has reached the split, so the lanes it does not take are drawn quieter. */
      reached?: boolean;
      /** The flow page: cases standing at the split's step that no lane claims (their case is not known yet). */
      cards?: ReactNode;
    };

export interface FlowCanvasModel {
  /** What starts the flow, in plain words. */
  trigger: { title: string; note?: string; produces?: FieldRef[] };
  nodes: CanvasNode[];
}
