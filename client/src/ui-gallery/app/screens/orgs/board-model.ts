/**
 * The cards of the Board: the open cases of the organizations the person
 * belongs to (placed by their status, so confirming a case in «Da fare» moves (allow-italian: quotes the Italian interface)
 * its card) and the tasks that live only on the Board (`fixtures/board.ts`,
 * plus the ones the reader added), each with the place it opens.
 */
import { CircleAlert, CircleCheck, Sparkles, type LucideIcon } from 'lucide-react';
import type { UiCopy } from '../../../../ui/copy/types';
import type { BoardCardModel, BoardChipModel, BoardColumnId } from '../../../../ui/board/model';
import type { Tone } from '../../../../ui/types';
import { BOARD_COLUMNS, BOARD_TASKS, type BoardTarget, type BoardTaskSeed } from '../../../../ui/fixtures/board';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { daysFromToday, formatShortDay } from '../../../../ui/fixtures/org/clock';
import { OFFICE_LABEL, ORGS, PERSONAS, type Persona } from '../../../../ui/fixtures/org/people';
import type { CaseStatus, OrgKey } from '../../../../ui/fixtures/org/types';
import { visibleCases, type LiveCase } from '../../store/cases';
import type { DemoState } from '../../store/state';
import { P } from '../../paths';

/** What the Board remembers on top of the seeds. */
export interface BoardSlice {
  /** Column of a task the reader moved, by task id. */
  moved: Record<string, BoardColumnId>;
  /** Tasks the reader added. */
  added: BoardTaskSeed[];
  /** Card ids touched, newest first: they lead their column. */
  touched: string[];
  /** Counter for the ids of added tasks. */
  next: number;
}

export const BOARD_INITIAL: BoardSlice = { moved: {}, added: [], touched: [], next: 1 };

export const CASE_COLUMN: Record<CaseStatus, BoardColumnId> = {
  'da-confermare': 'todo',
  'in-lavorazione': 'progress',
  'in-attesa': 'review',
  chiusa: 'done',
};

export const COLUMN_CASE_STATUS: Partial<Record<BoardColumnId, CaseStatus>> = {
  todo: 'da-confermare',
  progress: 'in-lavorazione',
  review: 'in-attesa',
  done: 'chiusa', // allow-italian: status code of the data, not shown
};

const CHIP_ICON: Record<NonNullable<BoardTaskSeed['chips']>[number]['icon'] & string, LucideIcon> = {
  sparkles: Sparkles,
  check: CircleCheck,
  alert: CircleAlert,
};

export const ORG_TONE: Record<OrgKey, Tone> = { nocera: 'green', orbit: 'amber', armonia: 'neutral', euro: 'blue' };

export interface BoardItem {
  id: string;
  kind: 'case' | 'task';
  org: OrgKey;
  column: BoardColumnId;
  area: string;
  title: string;
  chips: BoardChipModel[];
  /** Where the card leads; none for a card the reader added (it opens its own editor). */
  path?: string;
  /** What search matches on. */
  haystack: string;
  /** A task the reader added: it can be edited and deleted. */
  own?: boolean;
  due?: string;
}

const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** A date chip: red within a week, amber within three, grey after; «oggi» and «domani» in words. */
function dueChip(due: string, copy: UiCopy): BoardChipModel {
  const days = daysFromToday(due);
  const text = days === 0 ? copy.orgs.board.today : days === 1 ? copy.orgs.board.tomorrow : formatShortDay(due);
  const tone: Tone = days <= 7 ? 'red' : days <= 21 ? 'amber' : 'neutral';
  return { id: 'due', text, tone };
}

/** The place a Board-only card opens. A kind of case with no example case leads to the queue. */
export function targetPath(t: BoardTarget): string {
  switch (t.kind) {
    case 'procedure': return P.procedure(t.id);
    case 'flowTest': return P.flowTest(t.flow);
    case 'caseKind': {
      const c = CASES.find((x) => x.kind === t.caseKind && x.org === 'nocera');
      return c ? P.record(c.id) : P.inbox();
    }
    case 'data': return P.data();
    case 'deadlines': return P.deadlines();
    case 'quality': return P.quality();
    case 'programs': return P.programs();
    case 'settings': return P.settings(t.section);
    case 'orbitCallCenter': return P.orbitCallCenter();
    case 'orbitFlow': return P.orbitFlow(t.flow);
    case 'org': return t.org === 'nocera' ? P.overview() : t.org === 'orbit' ? P.orbitOverview() : P.org(t.org);
  }
}

const orgName = (org: OrgKey) => ORGS.find((o) => o.id === org)?.name ?? org;

function caseItem(c: LiveCase, copy: UiCopy): BoardItem {
  const flow = FLOWS.find((f) => f.id === c.flow);
  const due = c.deadlines.map((d) => d.date).sort()[0];
  const chips: BoardChipModel[] = [];
  if (due) chips.push(dueChip(due, copy));
  chips.push({ id: 'office', text: OFFICE_LABEL[c.office], tone: 'neutral' });
  if (c.urgent) chips.push({ id: 'urgent', text: copy.orgs.board.urgent, tone: 'red' });
  const assignee = PERSONAS.find((p) => p.id === c.assignee)?.name ?? '';
  const area = flow?.name ?? c.flow;
  return {
    id: c.id,
    kind: 'case',
    org: c.org,
    column: CASE_COLUMN[c.status],
    area,
    title: c.title,
    chips,
    path: c.org === 'orbit' ? P.orbitRecord(c.id) : P.record(c.id),
    haystack: norm(`${c.id} ${c.title} ${c.subject} ${area} ${orgName(c.org)} ${OFFICE_LABEL[c.office]} ${c.counterpart} ${assignee} ${c.protocol?.number ?? ''}`),
    due,
  };
}

function taskItem(t: BoardTaskSeed, column: BoardColumnId, own: boolean, copy: UiCopy): BoardItem {
  const chips: BoardChipModel[] = [];
  if (t.due) chips.push(dueChip(t.due, copy));
  (t.chips ?? []).forEach((c, i) => chips.push({ id: `c${i}`, text: c.text, tone: c.tone, icon: c.icon ? CHIP_ICON[c.icon] : undefined }));
  return {
    id: t.id,
    kind: 'task',
    org: t.org,
    column,
    area: t.area,
    title: t.title,
    chips,
    path: own ? undefined : targetPath(t.target),
    haystack: norm(`${t.title} ${t.area} ${orgName(t.org)} ${(t.chips ?? []).map((c) => c.text).join(' ')}`),
    own,
    due: t.due,
  };
}

/** Every card the person may see, in column order: touched cards first, then the order of the data. */
export function boardItems(state: DemoState, persona: Persona, slice: BoardSlice, copy: UiCopy): BoardItem[] {
  const cases = visibleCases(state, persona).map((c) => caseItem(c, copy));
  const tasks = [
    ...BOARD_TASKS.map((t) => taskItem(t, slice.moved[t.id] ?? t.column, false, copy)),
    ...slice.added.map((t) => taskItem(t, slice.moved[t.id] ?? t.column, true, copy)),
  ].filter((t) => persona.orgs.includes(t.org));
  const all = [...cases, ...tasks];
  const rank = (id: string) => {
    const at = slice.touched.indexOf(id);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  return all
    .map((item, order) => ({ item, order }))
    .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.order - b.order)
    .map((x) => x.item);
}

export function matches(item: BoardItem, query: string): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  return q.split(/\s+/).every((word) => item.haystack.includes(word.replace(/^@/, '')));
}

export function toCardModel(item: BoardItem): BoardCardModel {
  const org = ORGS.find((o) => o.id === item.org)!;
  const moveTo = BOARD_COLUMNS.filter((c) => c !== item.column && !(item.kind === 'case' && c === 'backlog'));
  return {
    id: item.id,
    org: { id: org.id, name: org.name, monogram: org.monogram, color: org.color },
    area: item.area,
    title: item.title,
    chips: item.chips,
    moveTo,
  };
}
