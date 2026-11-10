/**
 * The rows of the tables of the preview and what is done to them: build them
 * from the example cases with the reader's changes, filter, sort, group,
 * export. Pure functions, no words: labels come from the fixtures and from
 * the copy catalogue, handed in by the caller.
 */
import type { CaseSeed, CaseKind, CaseStatus, Office } from '../../../../ui/fixtures/org/types';
import { DEMO_NOW, daysFromToday, formatShortDay } from '../../../../ui/fixtures/org/clock';
import { PERSONAS, OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { Persona } from '../../../../ui/fixtures/org/people';
import {
  CANALS, KIND_TYPE, STATUS_LABEL, SUPPLIERS, TABLE_KINDS, type FilterSeed, type ViewSeed,
} from '../../../../ui/fixtures/data';
import type { DemoState } from '../../store/state';
import { visibleCases, type LiveCase } from '../../store/cases';
import type { QuarantineDecisions } from './quality';

/** A row the reader added by hand (slice `dataRows`). */
export interface AddedRow {
  id: string;
  title: string;
  kind: CaseKind;
  office: Office;
  by: string;
  at: string;
}

/** What a row is, before it is drawn: raw values to filter and sort by, and the case it stands for. */
export interface EngineRow {
  id: string;
  table: string;
  /** The case a row opens, when it is one. */
  caseId?: string;
  values: Record<string, string | number>;
  added?: boolean;
  unread?: boolean;
  /** For the other tables: the cases the row links to. */
  linkedCases?: string[];
  /** The quarantined item a row is waiting on. */
  quarantineId?: string;
}

const STATUS_ORDER: Record<CaseStatus, number> = { 'da-confermare': 0, 'in-lavorazione': 1, 'in-attesa': 2, chiusa: 3 };

/** The code of a taxpayer in Prunes: the example one of case 2418, and a stable one for the rest. */
export function taxpayerCode(caseId: string): string {
  if (caseId === '2418') return 'C-0048213';
  let h = 0;
  for (const ch of caseId) h = (h * 31 + ch.charCodeAt(0)) % 90000;
  return `C-00${String(10000 + h).padStart(5, '0')}`;
}

const NO_TAXPAYER: CaseKind[] = ['fattura', 'regione', 'send'];

export const hasTaxpayer = (c: { kind: CaseKind }) => !NO_TAXPAYER.includes(c.kind);

/** The protocol number as the table prints it: `2026/0018421` is `18421`. */
export function shortProtocol(number: string | undefined): string {
  if (!number) return '';
  const last = number.split('/').pop() ?? number;
  const n = Number(last);
  return Number.isFinite(n) && n > 0 ? String(n) : last;
}

/** The nearest deadline of a case that is a term (not a reminder), open cases only. */
export function nearestDeadline(c: CaseSeed): string {
  if (c.status === 'chiusa') return '';  // allow-italian: id of the fixture data, not shown
  const days = c.deadlines.filter((d) => !d.id.startsWith('avviso')).map((d) => d.date).sort();  // allow-italian: id of the fixture data, not shown
  const upcoming = days.find((d) => daysFromToday(d) >= 0);
  return upcoming ?? days[days.length - 1] ?? '';
}

export function isCaseTable(table: string): boolean {
  return table in TABLE_KINDS;
}

function caseRow(c: LiveCase, table: string, read: string[]): EngineRow {
  const type = KIND_TYPE[c.kind];
  const arrivedDays = (Date.parse(DEMO_NOW) - Date.parse(c.arrivedAt)) / 86_400_000;
  return {
    id: c.id,
    table,
    caseId: c.id,
    unread: arrivedDays <= 3 && c.status !== 'chiusa' && !read.includes(c.id),  // allow-italian: id of the fixture data, not shown
    values: {
      oggetto: c.title,
      tipo: type?.letter ?? '',
      stato: c.status,
      ufficio: c.office,
      resp: c.assignee,
      contribuente: hasTaxpayer(c) ? taxpayerCode(c.id) : '',
      protocollo: shortProtocol(c.protocol?.number),
      scadenza: nearestDeadline(c),
      corrected: c.live.values && Object.keys(c.live.values).length ? 1 : 0,
    },
  };
}

function addedCaseRow(a: AddedRow, persona: Persona): EngineRow {
  const type = KIND_TYPE[a.kind];
  return {
    id: a.id,
    table: 'pratiche',
    added: true,
    unread: true,
    values: {
      oggetto: a.title,
      tipo: type?.letter ?? '',
      stato: 'in-lavorazione',
      ufficio: a.office,
      resp: a.by || persona.id,
      contribuente: '',
      protocollo: '',
      scadenza: '',
      corrected: 0,
    },
  };
}

/** Rows of a table of the preview, for the person who looks. */
export function buildRows(table: string, state: DemoState, persona: Persona, added: AddedRow[], read: string[], decisions: QuarantineDecisions): EngineRow[] {
  const cases = visibleCases(state, persona, 'nocera');
  const kinds = TABLE_KINDS[table];
  if (isCaseTable(table)) {
    const rows = cases.filter((c) => !kinds || kinds.includes(c.kind)).map((c) => caseRow(c, table, read));
    const mine = added.filter((a) => !kinds || kinds.includes(a.kind)).map((a) => addedCaseRow(a, persona));
    return [...mine, ...rows];
  }
  if (table === 'contribuenti') {
    const byCode = new Map<string, { name: string; comune: string; cases: LiveCase[] }>();
    for (const c of cases.filter(hasTaxpayer)) {
      const code = taxpayerCode(c.id);
      const hit = byCode.get(code) ?? { name: c.counterpart, comune: c.comune ?? c.parcel?.comune ?? '', cases: [] };
      hit.cases.push(c);
      byCode.set(code, hit);
    }
    return [...byCode.entries()].map(([code, v]) => ({
      id: code,
      table,
      linkedCases: v.cases.map((c) => c.id),
      values: {
        nome: v.name,
        codice: code,
        comune: v.comune,
        pratiche: v.cases.length,
        ultima: v.cases.map((c) => c.arrivedAt.slice(0, 10)).sort().pop() ?? '',
      },
    }));
  }
  if (table === 'canali') {
    return CANALS.map((k) => {
      const linked = cases.filter((c) => `${c.parcel?.canale ?? ''} ${c.title} ${c.subject}`.toLowerCase().includes(k.match));
      return {
        id: k.id,
        table,
        linkedCases: linked.map((c) => c.id),
        values: { nome: k.name, tipo: k.kind, comune: k.comune ?? '', pratiche: linked.length, fonte: k.source },
      };
    });
  }
  if (table === 'fornitori') {
    const invoices = cases.filter((c) => c.kind === 'fattura');
    const rows: EngineRow[] = SUPPLIERS.map((s) => {
      const linked = invoices.filter((c) => c.counterpart.toLowerCase().includes(s.name.toLowerCase().split(' ')[0]));
      const decision = s.id === 'idraulica-sud' ? decisions['q-iban']?.status : undefined;
      const onHold = s.id === 'idraulica-sud' && decision !== 'confirmed';
      const newIban = decision === 'confirmed';
      return {
        id: s.id,
        table,
        linkedCases: linked.map((c) => c.id),
        quarantineId: onHold ? 'q-iban' : undefined,
        values: { nome: s.name, programma: 'teamsystem', iban: newIban ? 'IT…3456' : s.iban, dal: s.since, fatture: s.invoices + linked.length, anagrafica: onHold ? 'hold' : 'ok' },
      };
    });
    return rows;
  }
  return [];
}

/* ---------- filters ---------- */

export type Filter = FilterSeed;

export function matchesFilter(row: EngineRow, f: Filter): boolean {
  const value = row.values[f.col];
  if (f.op === 'within') {
    const day = String(value ?? '');
    if (!day) return false;
    const d = daysFromToday(day);
    return d >= 0 && d <= Number(f.value);
  }
  const same = String(value ?? '') === f.value;
  return f.op === 'is' ? same : !same;
}

export function applyView(rows: EngineRow[], filters: Filter[], q: string, rule: ViewSeed['rule'], persona: Persona): EngineRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (!filters.every((f) => matchesFilter(r, f))) return false;
    if (rule === 'mine' && r.values.resp !== persona.id) return false;
    if (rule === 'corrected' && !r.values.corrected) return false;
    if (!words.length) return true;
    const hay = Object.values(r.values).join(' ').toLowerCase();
    const label = describeValues(r).toLowerCase();
    return words.every((w) => hay.includes(w) || label.includes(w));
  });
}

/** The words the reader sees for the raw values of a row, so a search finds «Legale» and «In lavorazione». */
function describeValues(r: EngineRow): string {
  const parts: string[] = [];
  const statusValue = r.values.stato;
  if (typeof statusValue === 'string' && statusValue in STATUS_LABEL) parts.push(STATUS_LABEL[statusValue as CaseStatus]);
  const officeValue = r.values.ufficio;
  if (typeof officeValue === 'string' && officeValue in OFFICE_LABEL) parts.push(OFFICE_LABEL[officeValue as Office]);
  const resp = PERSONAS.find((p) => p.id === r.values.resp);
  if (resp) parts.push(resp.name);
  return parts.join(' ');
}

/* ---------- sort and group ---------- */

export interface Sort {
  col: string;
  dir: 'asc' | 'desc';
}

function sortKey(row: EngineRow, col: string): string | number {
  const v = row.values[col];
  if (col === 'stato') return STATUS_ORDER[v as CaseStatus] ?? 9;  // allow-italian: id of the fixture data, not shown
  return v ?? '';
}

export function sortRows(rows: EngineRow[], sort: Sort | null): EngineRow[] {
  if (!sort) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortKey(a, sort.col);
    const y = sortKey(b, sort.col);
    // Empty values go last whatever the direction.
    if (x === '' && y !== '') return 1;
    if (y === '' && x !== '') return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'it', { numeric: true }) * sign;
  });
}

export interface Group {
  key: string;
  rows: EngineRow[];
}

export function groupRows(rows: EngineRow[], col: string | null): Group[] {
  if (!col) return [{ key: '', rows }];
  const groups = new Map<string, EngineRow[]>();
  for (const r of rows) {
    const key = String(r.values[col] ?? '');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const keys = [...groups.keys()];
  if (col === 'stato') keys.sort((a, b) => (STATUS_ORDER[a as CaseStatus] ?? 9) - (STATUS_ORDER[b as CaseStatus] ?? 9));  // allow-italian: id of the fixture data, not shown
  else keys.sort();
  return keys.map((key) => ({ key, rows: groups.get(key) ?? [] }));
}

/* ---------- dates ---------- */

/** `04/01` for a day, empty for none. */
export const shortDay = (day: string | number | undefined) => (typeof day === 'string' && day ? formatShortDay(day) : '');

/** A deadline within a week reads red; past, too. */
export const isUrgentDay = (day: string | number | undefined) => typeof day === 'string' && day !== '' && daysFromToday(day) <= 7;


/* ---------- CSV ---------- */

/** A CSV that Excel opens with the Italian settings: semicolons and a byte-order mark. */
export function toCsv(header: string[], lines: string[][]): string {
  const cell = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return `\uFEFF${[header, ...lines].map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}

/** Starts a download of a text file, from a `data:` address. */
export function downloadText(name: string, text: string, mime: string): void {
  const a = document.createElement('a');
  a.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

