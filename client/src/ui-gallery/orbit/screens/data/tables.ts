/**
 * The tables of «Dati», composed from the live world every time: one row per (allow-italian: quotes the Italian interface)
 * card of a group of flows (the same cards the kanban draws, through `liveCards`), one
 * per contract (through `liveContracts`), one per town served. Nothing here is
 * stored: a card moved on the kanban changes its row, its group and every
 * count at once. Also the small engine the table screen runs on: filters,
 * search, order, groups, and the CSV of what is on show.
 */
import type { CellModel } from '../../../../ui/data/model';
import type { Tone } from '../../../../ui/types';
import type { OrbitDataCopy } from '../../../../ui/copy/orbit-data';
import type { Contract, ContractStatus, OrbitCard, StageId } from '../../../../ui/fixtures/orbit-org/types';
import { personaById, townOfPlace, world } from '../../world';
import type { OrbitTown } from '../../../../ui/fixtures/orbit-org/data';
import { formatDay, formatShortDay } from '../../../../ui/fixtures/org/clock';
import type { DemoState } from '../../../app/store/state';
import { liveCards, liveContracts, stageOf, stageSince } from '../../model/live';
import { formatHours, hoursBetween, isStuck } from '../../model/stages';
import { contractAlerts, currentValue, currentVersion, daysTo, formatMoney, kindLabel, latestVersion, noticeDate, statusLabel } from '../../model/contracts';
import { actorName, workerActor } from '../../model/who';
import { STAGE_TONE, stageLabel } from '../../model/words';
import { SP } from '../../paths';

/** The address segment of a table: the tables of cards the world lists, then `contratti` and `comuni`. */
export type TableId = string;

export const TABLE_IDS: TableId[] = [...world().dataTables.map((t) => t.id), 'contratti', 'comuni']; // allow-italian: address segments, compared by value

/** The flows whose cards a table lists; the first is the main one (the one a link from the table puts on the filter of «Da fare»). (allow-italian: quotes the Italian interface) */
const FLOWS_OF: Partial<Record<TableId, string[]>> = Object.fromEntries(world().dataTables.map((t) => [t.id, t.flows]));

export const isTable = (id: string | undefined): id is TableId => Boolean(id) && TABLE_IDS.includes(id as TableId);
/** The main flow of a table of cards, when it has one. */
export const flowOfTable = (t: TableId): string | undefined => FLOWS_OF[t]?.[0];
/** The table a card's row lives in. */
export const tableOfCard = (card: OrbitCard): TableId => TABLE_IDS.find((t) => FLOWS_OF[t]?.includes(card.flow)) ?? TABLE_IDS[0];
export type TableFamily = 'cards' | 'contracts' | 'towns';
export const familyOf = (t: TableId): TableFamily => (FLOWS_OF[t] ? 'cards' : t === 'contratti' ? 'contracts' : 'towns'); // allow-italian: address segment, compared by value

/* ---------- columns and rows ---------- */

export interface ColumnDef {
  id: string;
  label: string;
  width?: number;
  /** How the filter form offers it: one of the values, or a number of days from today. */
  filter?: 'select' | 'within';
  /** Rows can be grouped (and charted) by it. */
  group?: boolean;
  /** Shown before the reader picks the columns. */
  shown: boolean;
  /** Always shown: the column that names the row. */
  fixed?: boolean;
}

export interface DataRow {
  id: string;
  title: string;
  /** The text of every column: what search, filters, groups and the CSV read. */
  text: Record<string, string>;
  /** What a column sorts by, when not its text. */
  order: Record<string, string | number>;
  /** The day (`YYYY-MM-DD`) of a dated column, for the «within» filters. (allow-italian: quotes the Italian interface) */
  day: Record<string, string>;
  cells: Record<string, CellModel>;
  /** Where a link cell leads: a path of the app, or an `https://` page. */
  links: Record<string, string>;
  card?: OrbitCard;
  contract?: Contract;
  town?: OrbitTown;
}

/** The same tones «Contratti» gives each state, so a contract reads the same in both places. (allow-italian: quotes the Italian interface) */
export const STATUS_TONE: Record<ContractStatus, Tone> = { bozza: 'neutral', revisione: 'amber', approvazione: 'amber', firma: 'blue', attivo: 'green', rinnovo: 'blue', scaduto: 'red' }; // allow-italian: status ids, compared by value
const PRIORITY_RANK: Record<OrbitCard['priority'], number> = { alta: 0, normale: 1, bassa: 2 }; // allow-italian: data codes, compared by value
const STAGE_RANK: Record<StageId, number> = Object.fromEntries(world().stages.map((s, i) => [s.id, i])) as Record<StageId, number>;
const DONE: StageId = 'fatto'; // allow-italian: stage id, compared by value

/** The tone and the name of a stage are the ones every other screen uses (`model/words.ts`): a card reads the same here and in «Da fare». (allow-italian: quotes the Italian interface) */
export { STAGE_TONE, stageLabel };
export const isOpenCard = (c: OrbitCard) => stageOf(c) !== DONE;
export const flowOf = (id: string) => world().opsFlows.find((f) => f.id === id);
export const personShort = (id: string) => personaById(id)?.short ?? id;

export function cardsOfTable(state: DemoState, t: TableId): OrbitCard[] {
  const flows = FLOWS_OF[t];
  return flows ? liveCards(state).filter((c) => flows.includes(c.flow)) : [];
}

export function townCards(state: DemoState, town: OrbitTown): OrbitCard[] {
  return liveCards(state).filter((c) => townOfPlace(c.place)?.id === town.id);
}

/** Every column a table can show, in order; the value columns come from what the agents read on its cards. */
export function columnsOf(t: TableId, s: OrbitDataCopy, cards: OrbitCard[]): ColumnDef[] {
  const c = s.columns;
  if (familyOf(t) === 'contracts') {
    return [
      { id: 'title', label: c.contract, shown: true, fixed: true },
      { id: 'kind', label: c.kind, width: 110, filter: 'select', group: true, shown: false },
      { id: 'counterparty', label: c.counterparty, width: 200, filter: 'select', shown: false },
      { id: 'value', label: c.value, width: 150, shown: true },
      { id: 'end', label: c.end, width: 110, filter: 'within', shown: true },
      { id: 'notice', label: c.notice, width: 120, filter: 'within', shown: true },
      { id: 'status', label: c.status, width: 130, filter: 'select', group: true, shown: true },
      { id: 'version', label: c.version, width: 120, shown: false },
      { id: 'owner', label: c.owner, width: 130, filter: 'select', group: true, shown: false },
      { id: 'area', label: c.area, width: 170, filter: 'select', group: true, shown: false },
      { id: 'cig', label: c.cig, width: 110, shown: false },
      { id: 'alerts', label: c.alerts, width: 120, shown: true },
      { id: 'next', label: c.next, width: 220, shown: false },
    ];
  }
  if (familyOf(t) === 'towns') {
    return [
      { id: 'title', label: c.town, shown: true, fixed: true },
      { id: 'province', label: c.province, width: 70, filter: 'select', group: true, shown: true },
      { id: 'service', label: c.service, width: 280, shown: true },
      { id: 'since', label: c.from, width: 200, shown: false },
      { id: 'state', label: c.state, width: 130, filter: 'select', group: true, shown: true },
      { id: 'contracts', label: c.contracts, width: 100, shown: false },
      { id: 'cards', label: c.cards, width: 100, shown: false },
      { id: 'source', label: c.source, width: 200, shown: true },
    ];
  }
  const base: ColumnDef[] = [
    { id: 'code', label: c.code, width: 90, shown: true },
    { id: 'title', label: c.title, shown: true, fixed: true },
    { id: 'stage', label: c.stage, width: 130, filter: 'select', group: true, shown: true },
    { id: 'worker', label: c.worker, width: 180, filter: 'select', group: true, shown: true },
    { id: 'reviewer', label: c.reviewer, width: 130, filter: 'select', group: true, shown: false },
    { id: 'place', label: c.place, width: 160, filter: 'select', group: true, shown: false },
    { id: 'due', label: c.due, width: 100, filter: 'within', shown: true },
    { id: 'since', label: c.since, width: 110, shown: false },
    { id: 'priority', label: c.priority, width: 100, filter: 'select', group: true, shown: false },
    { id: 'stopped', label: c.stopped, width: 170, filter: 'select', group: true, shown: false },
    { id: 'flow', label: c.flow, width: 200, filter: 'select', group: true, shown: false },
  ];
  const counts = new Map<string, number>();
  for (const card of cards) for (const v of card.values) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
  const labels = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label]) => label);
  return [...base, ...labels.map((label) => ({ id: `v:${label}`, label, width: 150, shown: false }))];
}

/** A code drawn with a non-breaking hyphen, so a narrow column never splits `SG-4131` over two lines; the text, search and CSV keep the plain one. */
const unbroken = (code: string) => code.replace(/-/g, '\u2011');

/** The tone of a due day, the one the kanban gives it: red when past or today, amber within three days. */
export const dueTone = (day: string, today: string, open: boolean): Tone | undefined => {
  if (!open) return undefined;
  const n = daysTo(day, today);
  return n <= 0 ? 'red' : n <= 3 ? 'amber' : undefined;
};

function cardRow(card: OrbitCard, s: OrbitDataCopy, now: string): DataRow {
  const v = s.values;
  const today = now.slice(0, 10);
  const stage = stageOf(card);
  const open = stage !== DONE;
  const hours = hoursBetween(stageSince(card), now);
  const stuck = open && isStuck(card, world().opsFlows, now);
  const worker = actorName(workerActor(card.worker));
  const reviewer = personShort(card.reviewer);
  const flow = flowOf(card.flow);
  const stepAt = flow ? flow.steps.findIndex((x) => x.id === card.step) : -1;
  const step = flow && stepAt >= 0 ? flow.steps[stepAt] : undefined;
  const town = townOfPlace(card.place);
  const blockedHours = card.blocked ? hoursBetween(card.blocked.since, now) : 0;
  const stoppedText = card.blocked && open ? v.stuck(formatHours(blockedHours)) : stuck ? v.stuckShort : v.notStopped;
  const text: Record<string, string> = {
    code: card.id,
    title: card.title,
    stage: stageLabel(stage),
    worker,
    reviewer,
    place: card.place ?? '',
    due: card.due ? formatDay(card.due) : '',
    since: formatHours(hours),
    priority: v.priority[card.priority],
    stopped: stoppedText,
    flow: flow?.name ?? card.flow,
  };
  const cells: Record<string, CellModel> = {
    code: { kind: 'text', text: unbroken(card.id), tone: 'neutral' },
    title: { kind: 'title', text: card.title },
    stage: { kind: 'status', text: text.stage, tone: STAGE_TONE[stage], waiting: stuck },
    worker: { kind: 'link', field: { kind: card.worker.kind === 'agent' ? 'bolt' : 'person', name: worker } },
    reviewer: { kind: 'link', field: { kind: 'person', name: reviewer } },
    place: town ? { kind: 'link', field: { kind: 'folder', name: text.place } } : text.place ? { kind: 'text', text: text.place } : { kind: 'empty' },
    due: card.due ? { kind: 'text', text: text.due, tone: dueTone(card.due, today, open) } : { kind: 'empty' },
    since: { kind: 'text', text: text.since, tone: stuck ? 'amber' : undefined },
    priority: card.priority === 'alta' ? { kind: 'status', text: text.priority, tone: 'red' } : { kind: 'text', text: text.priority }, // allow-italian: data code, compared by value
    stopped: card.blocked && open ? { kind: 'text', text: v.stuck(formatHours(blockedHours)), tone: 'red' } : stuck ? { kind: 'text', text: v.stuck(formatHours(hours)), tone: 'amber' } : { kind: 'empty' },
    /* the step by its number, as «Flussi» prints it, never its code (allow-italian: quotes the Italian interface) */
    flow: { kind: 'link', field: { kind: 'bolt', name: step ? s.common.step(text.flow, stepAt + 1) : text.flow } },
  };
  const links: Record<string, string> = {
    worker: SP.person(card.worker.id),
    reviewer: SP.person(card.reviewer),
    flow: step ? SP.flowStep(card.flow, step.id) : SP.flow(card.flow),
  };
  if (town) links.place = SP.dataRow('comuni', town.id); // allow-italian: address segment, not shown
  for (const value of card.values) {
    text[`v:${value.label}`] = value.value;
    cells[`v:${value.label}`] = { kind: 'text', text: value.value, tone: value.confidence < 85 ? 'amber' : undefined };
  }
  return {
    id: card.id,
    title: `${card.id} · ${card.title}`,
    text,
    order: { stage: STAGE_RANK[stage], due: card.due ?? '9999-12-31', since: hours, priority: PRIORITY_RANK[card.priority], stopped: card.blocked && open ? 0 : stuck ? 1 : 2 },
    day: card.due ? { due: card.due } : {},
    cells,
    links,
    card,
  };
}

/** The first obligation not done, by its date. */
export function nextObligation(c: Contract) {
  return [...c.obligations].filter((o) => !o.done && o.due).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))[0];
}

function contractRow(c: Contract, s: OrbitDataCopy, today: string, cards: OrbitCard[]): DataRow {
  const v = s.values;
  const notice = noticeDate(c);
  const current = currentVersion(c);
  const latest = latestVersion(c);
  const alerts = contractAlerts(c, today, cards);
  const next = nextObligation(c);
  const value = currentValue(c);
  const valueText = `${s.common.euro(formatMoney(value))} ${v.period[c.valuePeriod]}`;
  const noticeLeft = notice ? daysTo(notice, today) : undefined;
  const text: Record<string, string> = {
    title: c.title,
    kind: kindLabel[c.kind],
    counterparty: c.counterparty,
    value: valueText,
    end: c.end ? formatDay(c.end) : v.noEnd,
    notice: notice ? formatDay(notice) : v.noNotice,
    status: statusLabel[c.status],
    version: latest.n > current.n ? v.versionOpen(current.n, latest.n) : v.version(current.n),
    owner: personShort(c.owner),
    area: world().people.areaLabel[c.area],
    cig: c.cig ?? '',
    alerts: alerts.length ? v.alerts(alerts.length) : '',
    next: next?.due ? `${formatShortDay(next.due)} · ${next.what}` : '',
  };
  const worst = alerts[0];
  const cells: Record<string, CellModel> = {
    title: { kind: 'title', text: c.title },
    kind: { kind: 'text', text: text.kind },
    counterparty: { kind: 'text', text: text.counterparty },
    value: { kind: 'text', text: text.value },
    end: { kind: 'text', text: text.end, tone: c.end && c.end < today ? 'red' : undefined },
    notice: notice ? { kind: 'text', text: text.notice, tone: noticeLeft === undefined || noticeLeft < 0 ? 'neutral' : noticeLeft <= 30 ? 'red' : noticeLeft <= 90 ? 'amber' : undefined } : { kind: 'empty' },
    status: { kind: 'status', text: text.status, tone: STATUS_TONE[c.status] },
    version: { kind: 'text', text: text.version },
    owner: { kind: 'link', field: { kind: 'person', name: text.owner } },
    area: { kind: 'text', text: text.area },
    cig: c.cig ? { kind: 'text', text: c.cig } : { kind: 'empty' },
    alerts: worst ? { kind: 'status', text: text.alerts, tone: worst.tone === 'error' ? 'red' : worst.tone === 'warn' ? 'amber' : 'blue' } : { kind: 'empty' },
    next: next ? { kind: 'link', field: { kind: 'calendar', name: text.next } } : { kind: 'empty' },
  };
  const links: Record<string, string> = { owner: SP.person(c.owner) };
  if (next) links.next = SP.clause(c.id, next.clause);
  return {
    id: c.id,
    title: c.title,
    text,
    order: { value, end: c.end || '9999-12-31', notice: notice ?? '9999-12-31' },
    day: { ...(c.end ? { end: c.end } : {}), ...(notice && notice >= today ? { notice } : {}) },
    cells,
    links,
    contract: c,
  };
}

function townRow(town: OrbitTown, s: OrbitDataCopy, state: DemoState): DataRow {
  const v = s.values;
  const open = townCards(state, town).filter(isOpenCard).length;
  const text: Record<string, string> = {
    title: town.name,
    province: town.province,
    service: town.service,
    since: town.since,
    state: town.past ? v.townPast : v.townActive,
    contracts: town.contracts.length ? s.common.contracts(town.contracts.length) : '',
    cards: open ? s.common.cards(open) : '',
    source: town.source.host,
  };
  return {
    id: town.id,
    title: town.name,
    text,
    order: { contracts: town.contracts.length, cards: open },
    day: {},
    cells: {
      title: { kind: 'title', text: town.name },
      province: { kind: 'text', text: town.province },
      service: { kind: 'text', text: town.service },
      since: { kind: 'text', text: town.since },
      state: { kind: 'status', text: text.state, tone: town.past ? 'neutral' : 'green' },
      contracts: town.contracts.length ? { kind: 'text', text: text.contracts } : { kind: 'empty' },
      cards: open ? { kind: 'text', text: text.cards } : { kind: 'empty' },
      source: { kind: 'link', field: { kind: 'link', name: town.source.host } },
    },
    links: { source: town.source.url },
    town,
  };
}

/** The rows of a table, in the order of the source. */
export function rowsOf(t: TableId, state: DemoState, s: OrbitDataCopy, now: string): DataRow[] {
  const family = familyOf(t);
  if (family === 'contracts') {
    const cards = liveCards(state);
    return liveContracts(state).map((c) => contractRow(c, s, now.slice(0, 10), cards));
  }
  if (family === 'towns') return world().towns.map((town) => townRow(town, s, state));
  return cardsOfTable(state, t).map((c) => cardRow(c, s, now));
}

/* ---------- filters, search, order, groups ---------- */

export interface Filter { col: string; op: 'is' | 'not' | 'within'; value: string }
export interface Sort { col: string; dir: 'asc' | 'desc' }

export const normalize = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function sortRows(rows: DataRow[], sort: Sort | null): DataRow[] {
  if (!sort) return rows;
  const key = (r: DataRow) => r.order[sort.col] ?? normalize(r.text[sort.col] ?? '');
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const result = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return result * sign || a.id.localeCompare(b.id);
  });
}

export interface RowGroup { id: string; label: string; rows: DataRow[] }

/** Rows under one label per value of `col`, the groups in the order of that column (stages in kanban order). */
export function groupRows(rows: DataRow[], col: string): RowGroup[] {
  if (!col) return [{ id: 'all', label: '', rows }];
  const groups = new Map<string, DataRow[]>();
  for (const r of rows) {
    const k = r.text[col] ?? '';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rank = (list: DataRow[]) => list[0]?.order[col] ?? normalize(list[0]?.text[col] ?? '');
  return [...groups.entries()]
    .sort((a, b) => {
      const x = rank(a[1]);
      const y = rank(b[1]);
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    })
    .map(([k, list]) => ({ id: k || 'none', label: k, rows: list }));
}

/* ---------- export ---------- */

const cell = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A CSV Excel opens as it is: BOM, `;` between cells, CRLF between lines. */
export function toCsv(head: string[], rows: string[][]): string {
  return `\uFEFF${[head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}

/** Hands the text to the browser as a file. */
export function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export { openExternal } from '../../external';
