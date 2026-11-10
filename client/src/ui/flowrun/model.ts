/**
 * View models of the «flows at work» area: the page of one step (a type
 * recognizer, an AI block, a fixed rule, a robot), the versions of a flow and
 * their test on real cases, the runs and one stopped run, and the page that
 * says how an AI step decides. Plain data: the container fills them from the
 * example fixtures and the state the reader changed.
 */
import type { FieldRef, Tone } from '../types';

/** What a step of a flow is, which decides its glyph and the page that configures it. */
export type StepKind = 'classify' | 'ai' | 'rule' | 'robot' | 'person' | 'program' | 'view' | 'send';

/* ---------- the flow, as the left rail of every page lists it ---------- */

export interface RailItem {
  id: string;
  /** `1`, `a`, `3a`; the trigger carries none. */
  marker?: string;
  kind: StepKind | 'trigger';
  /** The program a robot or program step works in. */
  program?: string;
  title: string;
  /** Quiet words on the right. */
  note?: string;
  /** Small chips after the kind: `nuovo`, `soglia 90% → 85%`, `3 tentativi`. (allow-italian: quotes the Italian interface) */
  badges?: Array<{ label: string; tone: Tone }>;
  state?: 'done' | 'error' | 'waiting' | 'todo';
  onSelect?: () => void;
  selected?: boolean;
}

/** The views of a flow, as the header's switcher names them. */
export type FlowViewId = 'steps' | 'byOffice' | 'runs' | 'tests' | 'versions' | 'log';

/* ---------- configuration of a step ---------- */

export interface FieldDef {
  id: string;
  name: string;
  type: string;
  required: boolean;
}

export interface Condition {
  id: string;
  /** Id of a field the rule can read. */
  field: string;
  op: 'lt' | 'gt' | 'in' | 'eq' | 'gte';
  /** A number, a word, or the name of a table. */
  value: string;
}

export interface ConditionField {
  id: string;
  label: string;
  kind: 'number' | 'list' | 'flag';
}

export interface ConditionOp {
  id: Condition['op'];
  label: string;
}

export interface ConditionSample {
  id: string;
  label: string;
  values: Record<string, number | boolean>;
}

/** A rule that runs before the AI and decides without it. */
export interface PreRule {
  id: string;
  when: string;
  then: string;
}

export interface ClassifyType {
  id: string;
  letter: string;
  name: string;
  when: string;
  perMonth: number;
  /** Percent right on the example check, a stima. */
  correct: number;
  goesTo: string;
}

export interface RobotSmallField {
  label: string;
  value: string;
}

export interface RobotStepModel {
  id: string;
  title: string;
  /** `menu Protocollo › Arrivo`. */
  detail?: string;
  /** The title bar of the picture of the page the robot sees. */
  page: string;
  fields: RobotSmallField[];
  /** The fields of the case the step reads from or writes into. */
  sources?: FieldRef[];
  /** The step that reads the result back. */
  result?: string;
}

export interface RunBars {
  /** Last 30 days: the volume of the day (0-1) and whether a run of it failed. */
  days: Array<{ value: number; failed?: boolean }>;
  ok: number;
  total: number;
  medianSec: number;
}

/* ---------- a test of a step ---------- */

export interface TryRow {
  label: string;
  value: string;
  source?: { label: string; onOpen?: () => void };
  tone?: Tone;
}

export interface TryResult {
  caseId: string;
  caseTitle: string;
  at: string;
  /** What the step read, what it returned, with the words it comes from. */
  input: TryRow[];
  output: TryRow[];
  /** One line: the same input gives the same output. */
  note?: string;
}

export interface JobView {
  title: string;
  progress: number;
  current?: string;
  status: 'running' | 'done' | 'failed';
  done: string[];
  failed?: string;
}

/* ---------- versions ---------- */

export interface VersionRow {
  id: string;
  n: number;
  status: 'active' | 'testing' | 'draft' | 'old';
  who: string;
  at: string;
  summary: string;
  selected?: boolean;
  onSelect?: () => void;
  menu: Array<{ id: string; label: string; danger?: boolean; disabled?: boolean; title?: string }>;
}

export interface DiffRow {
  id: string;
  marker?: string;
  kind: StepKind;
  program?: string;
  title: string;
  note?: string;
  badges: Array<{ label: string; tone: Tone }>;
  /** What the row is in the comparison. */
  change: 'changed' | 'added' | 'same' | 'removed';
  /** What differs, one line each, for the page of the selected row. */
  detail?: Array<{ label: string; before?: string; after?: string }>;
  selected?: boolean;
  onSelect?: () => void;
}

export interface TestCaseRow {
  id: string;
  label: string;
  confidence: number;
  before: string;
  after: string;
  /** `same` leaves the case where it was. */
  change: 'same' | 'better' | 'risky' | 'more-person' | 'new-flow';
  /** Opens the case (or the run, when the case is not in the examples). */
  onOpen?: () => void;
}

/* ---------- runs ---------- */

export type UiRunStatus = 'running' | 'person' | 'blocked' | 'error' | 'done' | 'archived';

export type RunActor = { kind: 'robot' | 'rule' | 'ai' | 'person'; text?: string; color?: string };

export interface RunRowModel {
  id: string;
  /** The case number as the table prints it. */
  caseNo: string;
  title: string;
  arrived: string;
  step: string;
  actor: RunActor;
  status: UiRunStatus;
  /** What the Stato chip says. (allow-italian: quotes the Italian interface) */
  statusText: string;
  duration: string;
  /** In progress: the duration is still growing. */
  live?: boolean;
  onOpen: () => void;
}

export interface ContextRow {
  id: string;
  source: string;
  kind: FieldRef['kind'];
  what: string;
  weight: string;
  state: 'present' | 'missing' | 'not-needed';
}
