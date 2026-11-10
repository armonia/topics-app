/**
 * The view models of the `team` area. Plain data, already worded: a screen
 * here only draws, the container of the preview computes and words.
 */
import type { MenuItemModel } from '../primitives/Menu';
import type { Action, CrumbModel, Tone } from '../types';
import type { StateIcon } from './parts';
import type { JobCardModel } from './parts';

/* ---------- c01 ---------- */

export interface CriterionRowModel {
  id: string;
  label: string;
  detail?: string;
  required: string;
  now: string;
  tone: Tone;
  icon: StateIcon;
  stateText: string;
  estimate?: boolean;
}

export type CaseOutcomeKind = 'pass' | 'fail' | 'unstable' | 'resolved';

export interface TestCaseRowModel {
  id: string;
  title: string;
  /** The number of the case, quiet under the title. */
  ref: string;
  people: string;
  flow: string;
  /** The flow's result differs from the people's: drawn in red. */
  differs: boolean;
  outcome: CaseOutcomeKind;
  onOpen?: () => void;
}

export interface DiffRowModel {
  id: string;
  title: string;
  ref: string;
  flow: string;
  rounds?: string;
  people: string;
  right: { tone: Tone; text: string };
  items: MenuItemModel[];
  onOpen?: () => void;
}

export interface HistoryRowModel {
  id: string;
  title: string;
  detail: string;
  /** Pass or not, for the glyph. */
  ok: boolean;
  selected: boolean;
  onSelect: () => void;
}

export type CaseFilter = 'all' | 'fail' | 'pass';

export interface FlowTestModel {
  crumbs: CrumbModel[];
  status: { text: string; tone: Tone };
  /** Stage on the stepper: 0 draft ... 4 live. */
  stage: number;
  criteria: { rows: CriterionRowModel[]; agreedWith: string; estimateNote: string };
  job?: JobCardModel;
  cases: {
    rows: TestCaseRowModel[];
    filter: CaseFilter;
    counts: Record<CaseFilter, number>;
    shown: number;
    total: number;
    /** Set while an older run is on show. */
    older?: string;
    emptyBody: string;
  };
  diffs: { rows: DiffRowModel[]; total: number; ran: boolean };
  history: HistoryRowModel[];
  aside: {
    fixed: { all: number; corrections: number; written: number };
    unstable?: { kind: string; office: string; ruleAdded: boolean };
    approver: string;
    nightly: number;
  };
  gate: {
    day: number;
    of: number;
    /** Wording of what is missing; empty when ready. */
    missing: string;
    ready: boolean;
    stage: number;
    requestedBy?: string;
    liveVersion?: number;
  };
}

export interface FlowTestActions {
  onViewChange: (view: 'steps' | 'runs' | 'tests' | 'versions') => void;
  onRun: Action;
  onFilter: (f: CaseFilter) => void;
  onBackToLast: () => void;
  onAddRule: Action;
  onOpenUnstable?: () => void;
  onGate: Action;
  /** A choice of the «Decidi» menu of a difference. */
  onDiffItem: (id: string, item: string) => void;
}

/* ---------- c02 ---------- */

export interface TestAllRowModel {
  id: string;
  name: string;
  kind: string;
  kindTone: Tone;
  version: number;
  state: { text: string; tone: Tone; icon: StateIcon };
  fixed: string;
  stability: string;
  last: string;
  approvedBy: string;
  onOpen?: () => void;
  /** The test of this row is running: the button says so and waits. */
  running?: boolean;
  onRun: Action;
}

export type TestAllFilter = 'all' | 'testing' | 'redo';

export interface AttentionModel {
  id: string;
  title: string;
  why: string;
  actionLabel: string;
  onOpen: () => void;
}

export interface TestAllModel {
  kpis: Array<{ id: string; label: string; value: string; detail: string; tone?: Tone }>;
  rows: TestAllRowModel[];
  counts: Record<TestAllFilter, number>;
  filter: TestAllFilter;
  job?: JobCardModel;
  attention: AttentionModel[];
  summary?: string;
}

/* ---------- c03, t01: permissions ---------- */

export interface MatrixRoleModel {
  id: string;
  label: string;
}

export interface MatrixRowModel {
  id: string;
  label: string;
  hint?: string;
  /** Whether each role has it, by role id. */
  values: Record<string, boolean>;
  /** Whether the reader changed it from the role's starting permissions, by role id. */
  changed: Record<string, boolean>;
}

export interface RightsCell {
  all?: boolean;
  items: string[];
}

export interface RightsRowModel {
  id: string;
  name: string;
  sees: RightsCell;
  proposes: RightsCell;
  edits: RightsCell;
  approves: RightsCell;
}

export interface ProposalModel {
  id: string;
  title: string;
  reason: string;
  asked: string;
  stage: number;
  stageLabels: string[];
  edits: string;
  approves: string;
  onOpen: () => void;
}

export interface YouRowModel {
  id: string;
  name: string;
  level: 'edit' | 'propose' | 'see' | 'none';
}

/* ---------- t01, n16: people ---------- */

export interface PersonRowModel {
  id: string;
  name: string;
  monogram: string;
  color: string;
  roleId: string;
  roleLabel: string;
  offices: string[];
  officeIds: string[];
  orgs: string[];
  orgIds: string[];
  you: boolean;
  example: boolean;
  sees: string;
}

export interface OptionModel {
  value: string;
  label: string;
}

export interface InviteRowModel {
  id: string;
  email: string;
  role: string;
  orgs: string[];
  sent: string;
  sending: boolean;
  onResend: Action;
  onCancel: Action;
}

/* ---------- t02: sharing ---------- */

export interface ShareRowModel {
  id: string;
  what: string;
  kind: string;
  who: string;
  email: string;
  can: string;
  until: string;
  opens: string;
  state: { tone: Tone; text: string };
  selected: boolean;
  onSelect: () => void;
}

export interface ShareDetailModel {
  id: string;
  what: string;
  kind: string;
  state: { tone: Tone; text: string };
  active: boolean;
  /** The reader may change its rules (it is live and they have the right). */
  editable: boolean;
  link: string;
  code: string;
  to: string;
  email: string;
  can: 'view' | 'comment';
  /** YYYY-MM-DD */
  until: string;
  /** What the guest always sees (the record's documents and drafts): a locked first row. */
  base?: string;
  includes: Array<{ id: string; label: string; on: boolean }>;
  watermark: boolean;
  opens: Array<{ id: string; at: string; who: string }>;
  createdBy: string;
  receipt?: { title: string; lines: string[] };
}

export interface ShareActions {
  onCopy: () => void;
  onTry: () => void;
  onOpenScope: () => void;
  onRevoke: Action;
  onCan: (v: 'view' | 'comment') => void;
  onUntil: (v: string) => void;
  onInclude: (id: string, next: boolean) => void;
  onWatermark: (next: boolean) => void;
}

export interface ShareDraft {
  scopeKind: 'record' | 'view';
  target: string;
  email: string;
  guest: string;
  can: 'view' | 'comment';
  until: string;
  includes: { contributor: boolean; sameContributor: boolean; assistant: boolean };
  watermark: boolean;
}

export type ShareFilter = 'active' | 'expired' | 'revoked' | 'all';

/* ---------- n16: connections ---------- */

export interface ConnectionRowModel {
  id: string;
  name: string;
  how: string;
  method: string;
  state: { tone: Tone; text: string; icon: StateIcon };
  by: string;
  last: string;
  selected: boolean;
  onSelect: () => void;
}

export interface ConnectionDetailModel {
  id: string;
  name: string;
  what: string;
  how: string;
  state: { tone: Tone; text: string; icon: StateIcon };
  problem?: string;
  by: string;
  last: string;
  rights: string;
  usedBy: Array<{ id: string; name: string; onOpen: () => void }>;
  job?: JobCardModel;
  /** The main action (Ricollega, Collega), the quiet one (Scollega) and the way to the programs. (allow-italian: quotes the Italian interface) */
  primary: { label: string; onClick: Action; variant: 'primary' | 'secondary' };
  disconnect?: { label: string; onClick: Action };
  onOpenPrograms: () => void;
}

export interface DataLinkModel {
  id: string;
  label: string;
  onOpen: () => void;
}

/* ---------- n15: the log ---------- */

export interface LogActorModel {
  kind: 'person' | 'ai' | 'robot' | 'access' | 'system';
  label: string;
  monogram?: string;
  color?: string;
}

export interface LogRowModel {
  id: string;
  when: string;
  actor: LogActorModel;
  what: string;
  subject: string;
  detail: string;
  hash: string;
  /** Written in this visit of the preview, not part of the month's seed. */
  live: boolean;
  /** Missing when the line has nothing else to open (it is about the log itself). */
  onOpen?: () => void;
}

export type LogFilter = 'all' | 'people' | 'ai' | 'robot' | 'structure' | 'access';

export interface LogModel {
  rows: LogRowModel[];
  total: number;
  filter: LogFilter;
  counts: Record<LogFilter, number>;
  query: string;
  person: string;
  people: OptionModel[];
  day: string;
  days: OptionModel[];
  chain: { checked: boolean; text: string; last: string };
}
