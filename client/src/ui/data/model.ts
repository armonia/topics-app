import type { FieldKind, FieldRef, Tone } from '../types';
import type { StageGlyph } from '../kanban/model';

/** The kinds of cell a table draws; a closed set, so an API row maps 1:1. */
export type CellModel =
  | { kind: 'title'; text: string }
  | { kind: 'text'; text: string; tone?: Tone }
  | { kind: 'status'; text: string; tone: Tone; waiting?: boolean }
  | { kind: 'link'; field: FieldRef }
  | { kind: 'type'; letter: string; field: FieldKind }
  | { kind: 'empty' };

export type DataView = 'table' | 'byStatus' | 'calendar' | 'chart';

/* ------------------------------------------------------------------ */
/* The live table of x01: sorting, selection, peeking at a row.         */
/* ------------------------------------------------------------------ */

export interface GridColumn {
  id: string;
  label: string;
  width?: number;
  sortable?: boolean;
}

export interface GridRow {
  id: string;
  cells: Record<string, CellModel>;
  /** Not yet seen by the reader: a dot before the title, the title in bold. */
  unread?: boolean;
  /** A small chip next to the title («added just now»). */
  badge?: string;
  /** Whether the row leads to a record of its own. */
  opens: boolean;
}

export interface GridGroup {
  id: string;
  label: string;
  rows: GridRow[];
}

export interface GridModel {
  columns: GridColumn[];
  groups: GridGroup[];
}

export interface SortState {
  col: string;
  dir: 'asc' | 'desc';
}

/** The panel of the row that is current: its fields, what it links to, its history. */
export interface PeekModel {
  id: string;
  tag: string;
  title: string;
  badge?: string;
  fields: Array<{ label: string; value: string; tone?: Tone; avatar?: { text: string; color: string } }>;
  linked: Array<{ id: string; field: FieldRef; value: string }>;
  history: Array<{ text: string; when: string }>;
  /** Present when the row leads to a record. */
  openLabel?: string;
}

export interface TableNavItem {
  id: string;
  label: string;
  count: string;
  /** What the count counts, read on hover and by a screen reader: a view counts rows of its table, not the lines of the schedule. */
  hint?: string;
}

/** A filter on the table as it is shown on its chip. */
export interface FilterChipModel {
  id: string;
  /** «Office = Legal» */
  text: string;
}

export interface FilterColumnModel {
  id: string;
  label: string;
  /** `select`: one of `options`; `within`: a number of days to count from today. */
  kind: 'select' | 'within';
  options: Array<{ value: string; label: string }>;
}

/** One card of the board by status, or one dot of the calendar. */
export interface CalendarItemModel {
  id: string;
  day: string;
  label: string;
  tone: Tone;
  /** What the item opens when pressed. */
  opens: boolean;
}

export interface StatusColumnModel {
  id: string;
  label: string;
  tone: Tone;
  /** The glyph of the state, as the same state wears it in the kanban; without it the column wears a dot of its tone. */
  glyph?: StageGlyph;
  cards: Array<{
    id: string;
    title: string;
    detail: string;
    deadline?: string;
    urgent?: boolean;
    /** The tone of the due day (red when past or today, amber when near), as the kanban tints it; without it `urgent` decides. */
    deadlineTone?: Tone;
    /** A card stopped on something or left in its state too long: the chip says since when, the edge and border take its tone. */
    stuck?: { text: string; tone: 'red' | 'amber' };
  }>;
}

export interface ChartBarModel {
  id: string;
  label: string;
  value: number;
  tone: Tone;
  /** A stage's bar wears the ink of that stage's glyph, the same one the kanban draws, instead of the tone's. */
  glyph?: StageGlyph;
}

/* ---------- the schedule of deadlines (n14) ---------- */

export interface DeadlineRowModel {
  id: string;
  dateText: string;
  label: string;
  officeLabel: string;
  about: string;
  writer: string;
  statusText: string;
  statusTone: Tone;
  /** A short relative-time line under the label. */
  when: string;
  example?: boolean;
}

export interface DeadlineDetailModel {
  id: string;
  title: string;
  statusText: string;
  statusTone: Tone;
  fields: Array<{ label: string; value: string; tone?: Tone }>;
  history: Array<{ text: string; when: string }>;
  /** The case the deadline belongs to, when it has one. */
  hasCase: boolean;
  done: boolean;
}

/* ---------- fields, rules and calculations (x02) ---------- */

export interface FieldRowModel {
  id: string;
  label: string;
  typeText: string;
  /** For a link: the type it points to, drawn as a chip. */
  linkTo?: string;
  ruleText: string;
  filled: { tone: Tone; text: string; note?: string };
  editedBy: string;
  calculated: boolean;
  added: boolean;
}

export interface FieldFormModel {
  id: string;
  label: string;
  type: string;
  required: boolean;
  ruleKind: string;
  ruleKinds: Array<{ value: string; label: string }>;
  rulePattern: string;
  ruleList: string;
  ruleMin: string;
  filledBy: string;
  filledOptions: Array<{ value: string; label: string }>;
  editedBy: string;
  editorOptions: Array<{ value: string; label: string }>;
  typeOptions: Array<{ value: string; label: string }>;
  added: boolean;
  calc?: {
    from: string;
    days: string;
    rollsOver: boolean;
    augustPause: boolean;
    norm: string;
    /** The formula worked out on an example row, one line each. */
    example: string[];
    alerts: Array<{ id: string; label: string; value: string; options: Array<{ value: string; label: string }> }>;
    appearsIn: Array<{ id: string; label: string; on: boolean }>;
  };
}

export interface RuleTestModel {
  status: 'idle' | 'running' | 'done';
  progress: number;
  current?: string;
  total: number;
  passed: number;
  untestable: boolean;
  failures: Array<{ id: string; title: string; value: string; expected?: string; why: string; canOpen: boolean }>;
}

/* ---------- types of data and their links (w04) ---------- */

export interface SchemaTypeItem {
  id: string;
  label: string;
  count: string;
  fieldKind: FieldKind;
  /** A type the reader just added. */
  added?: boolean;
}

export interface SchemaGroupModel {
  id: string;
  label: string;
  items: SchemaTypeItem[];
}

export interface SchemaDetailModel {
  id: string;
  label: string;
  about: string;
  /** Where its rows live: «vive in Topics», «in Prunes». */
  home: string;
  states?: Array<{ id: string; label: string; state: 'done' | 'current' | 'todo' }>;
  fields: Array<{ id: string; label: string; typeText: string; linkTo?: string; from: string; editedBy: string; required: string }>;
  links: Array<{ id: string; label: string; fieldKind: FieldKind; how: string }>;
  usedBy: Array<{ label: string; value: string }>;
  keep: Array<{ label: string; value: string }>;
  /** The chain from the case to the norm, with where the open type sits in it. */
  chain: Array<{ id: string; label: string; fieldKind: FieldKind; how?: string }>;
  tableLabel?: string;
}

export interface TableOverviewRow {
  id: string;
  label: string;
  summary: string;
  home: string;
  rows: string;
  fields: number;
}
