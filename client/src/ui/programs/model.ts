/**
 * The view models of the `programs` area: the list of programs by area, one
 * program in detail, the agent on a PC, smart search, migration advice, where
 * agents run and the remote control session. Plain data: a container fills
 * them from the fixtures plus what the reader did, and the components only
 * draw them.
 */
import type { Action, CrumbModel, FieldRef, Tone } from '../types';

/** How a program is reached by the AI. The words for each come from the copy catalogue. */
export type ConnectionKind = 'browser' | 'pc-agent' | 'api' | 'mcp-official' | 'mcp-open' | 'database' | 'imap' | 'file';

/** The four ways the list is filtered by: what the reader asks is «how does it connect». */
export type ConnectionFamily = 'api' | 'browser' | 'pc' | 'file';

export const FAMILY_OF: Record<ConnectionKind, ConnectionFamily> = {
  browser: 'browser',
  'pc-agent': 'pc',
  api: 'api',
  'mcp-official': 'api',
  'mcp-open': 'api',
  database: 'api',
  imap: 'api',
  file: 'file',
};

export const FAMILIES: ConnectionFamily[] = ['api', 'browser', 'pc', 'file'];

/** Where a program stands: working, still to be connected, only files, being tested, last test failed. */
export type ProgramStateKind = 'ok' | 'to-connect' | 'file' | 'testing' | 'failed';

/** What to do with a program in the long run. */
export type Verdict = 'stay' | 'integrate' | 'evaluate' | 'migrate';

export const VERDICT_TONE: Record<Verdict, Tone> = { stay: 'green', integrate: 'blue', evaluate: 'amber', migrate: 'violet' };

export const STATE_TONE: Record<ProgramStateKind, Tone> = { ok: 'green', 'to-connect': 'neutral', file: 'neutral', testing: 'blue', failed: 'red' };

/* ---------- w06: programs by area ---------- */

export interface ProgramRowModel {
  id: string;
  name: string;
  sub?: string;
  holds: FieldRef[];
  connection: { kind: ConnectionKind; label: string };
  usage: string;
  state: { kind: ProgramStateKind; text: string };
  /** «4 · restare», or `undefined` when nobody was found worth naming. */
  alternatives?: string;
  selected: boolean;
  onOpen?: Action;
}

export interface ProgramGroupModel {
  id: string;
  label: string;
  rows: ProgramRowModel[];
}

export interface ProgramDetailModel {
  id: string;
  connectionKind: ConnectionKind;
  connectionLabel: string;
  name: string;
  description: string;
  /** What Topics reads in it, one row per kind of data. */
  reads: Array<{ field: FieldRef; value: string }>;
  usedBy: Array<{ id: string; label: string; value: string; onOpen?: Action }>;
  access: Array<{ label: string; value: string }>;
  /** The result of the last test, if there is one. */
  lastCheck?: { tone: Tone; text: string; lines: string[] };
}

/** A job running or just finished, drawn under the control that started it. */
export interface JobViewModel {
  title: string;
  /** 0-1 */
  progress: number;
  current?: string;
  status: 'running' | 'done' | 'failed';
  done: string[];
  failed?: string;
}

/* ---------- p02: the agent on a PC ---------- */

export type AgentStepState = 'done' | 'current' | 'todo';

export interface AgentStepModel {
  id: string;
  label: string;
  state: AgentStepState;
  /** HH:mm when done, the word for «now» on the current one. */
  at?: string;
}

/** A field of the drawn program window: what is typed in it by now. */
export interface MaskFieldModel {
  id: string;
  label: string;
  value: string;
  /** The field the agent is typing in right now. */
  active?: boolean;
  /** Typed by the agent (drawn as filled) or by the example (shown as given). */
  muted?: boolean;
  /** Drawn as dots. */
  secret?: boolean;
  /** Set: the field is a real input the reader can type in (the value goes out through it). */
  onChange?: (value: string) => void;
  placeholder?: string;
  /** Where the field sits in the two columns of the mask. */
  column?: 0 | 1;
}

export interface MaskModel {
  program: string;
  /** The window title after the program name, e.g. «Contabilità · Registrazione fattura». (allow-italian: quotes the Italian interface) */
  title: string;
  fields: MaskFieldModel[];
  /** A menu of the program drawn instead of fields (before the agent opened the form). */
  menu?: { items: string[]; highlight?: number };
  /** A line under the fields, e.g. the number the program gave after saving. */
  result?: string;
  buttons: Array<{ id: string; label: string; primary?: boolean; onPress?: () => void }>;
  /** The line of the taskbar, on the right. */
  taskbarRight?: string;
  taskbarLeft: string[];
}

export interface FrameModel {
  id: string;
  /** The first line the thumbnail draws in its title bar and the field rows it shows. */
  fields: number;
  /** The label under the thumbnail, e.g. «21:03 Apre acquisti». (allow-italian: quotes the Italian interface) */
  label: string;
  future?: boolean;
}

export interface PcAgentModel {
  crumbs: CrumbModel[];
  live: { tone: Tone; text: string };
  mask: MaskModel;
  task: { title: string; description: string };
  steps: AgentStepModel[];
  checks: Array<{ label: string; value: string; ok?: boolean }>;
  queue: Array<{ label: string; value: string }>;
  frames: FrameModel[];
  /** A line under the steps when the agent is paused or stopped, saying why. */
  banner?: { tone: Tone; text: string };
}

/* ---------- p03: smart search ---------- */

export interface WhereHitModel {
  id: string;
  document: string;
  holds: string;
  program: { id: string; name: string; onOpen?: Action };
  path: string[];
  fetch: string;
  fetchKind: ConnectionKind;
  fetchLabel: string;
  /** A fetched example, once the reader asked for one. */
  fetched?: string;
  onFetch?: Action;
  busy?: boolean;
}

export interface CatalogHitModel {
  id: string;
  initial: string;
  color: string;
  name: string;
  maker: string;
  /** «già in uso da voi», «concorrente», or nothing. (allow-italian: quotes the Italian interface) */
  tag?: { text: string; tone: Tone };
  description: string;
  connection: { kind: ConnectionKind; label: string };
  facts: string[];
  links: Array<{ id: string; label: string }>;
  archived: boolean;
  onPrimary?: Action;
  primaryLabel: string;
  primaryIcon: 'plus' | 'open';
}

export interface FacetModel {
  id: string;
  label: string;
  on: boolean;
}

/* ---------- p04: competitors and migration ---------- */

export interface AlternativeRowModel {
  id: string;
  name: string;
  current?: boolean;
  holds: string;
  connection: { kind: ConnectionKind; label: string };
  cloud: string;
  effort: string;
  selected: boolean;
  onSelect?: Action;
}

export interface AdviceRowModel {
  id: string;
  name: string;
  verdict: Verdict;
  verdictLabel: string;
  reason: string;
  effort: string;
  selected: boolean;
  onOpen?: Action;
}

export interface AdviceModel {
  verdict: Verdict;
  verdictLabel: string;
  headline: string;
  reason: string;
  revisit: Array<{ when: string; then: string }>;
  plan: Array<{ label: string; value: string }>;
  planTotal?: string;
  risks: string;
}

/** The phases of a migration drawn as bars on a time line, in months. */
export interface PlanBarModel {
  id: string;
  label: string;
  months: number;
  /** The month the phase starts at, counted from zero. */
  start: number;
}

export interface MigrationModel {
  name: string;
  connection: { kind: ConnectionKind; label: string };
  holdsLabel: string;
  heading: string;
  research: string;
  rows: AlternativeRowModel[];
  matters: Array<{ label: string; value: string }>;
  advice: AdviceModel;
  bars: PlanBarModel[];
  /** What changes if the reader picks an alternative, as rows. */
  picked?: { name: string; lines: Array<{ label: string; value: string }> };
  now: {
    state: { kind: ProgramStateKind; text: string };
    access: Array<{ label: string; value: string }>;
    options: Array<{ kind: ConnectionKind; label: string; about: string; current: boolean }>;
  };
}

/* ---------- e01: where agents run ---------- */

export type PcStateKind = 'working' | 'ready' | 'too-old' | 'updating' | 'pending' | 'removed';

export interface PcRowModel {
  id: string;
  name: string;
  where: string;
  traits: string;
  does: string;
  state: { kind: PcStateKind; text: string };
  lastSeen: string;
  selected: boolean;
  onOpen?: Action;
}

export interface PlaceCardModel {
  id: string;
  kind: 'browser' | 'pc' | 'remote';
  tag: string;
  title: string;
  description: string;
  stateLabel: string;
  stateText: string;
  stateTone: Tone;
  pressed: boolean;
  onPress?: Action;
}

export interface PcDetailModel {
  id: string;
  name: string;
  tag: string;
  rows: Array<{ label: string; value: string }>;
  note?: string;
  noteTone?: Tone;
}

/* ---------- e02: remote control ---------- */

export type RemoteStatus = 'idle' | 'asked' | 'live' | 'denied' | 'ended';
