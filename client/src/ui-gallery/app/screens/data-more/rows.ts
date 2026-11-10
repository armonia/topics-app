/**
 * From the rows of the engine to what the table, the board, the chart and the
 * side panel draw: cells, groups, cards, bars, the panel of one row. The words
 * come from the fixtures (the sector) and from the copy catalogue (the product).
 */
import type {
  CellModel, ChartBarModel, GridModel, GridRow, PeekModel, StatusColumnModel,
} from '../../../../ui/data/model';
import type { Tone } from '../../../../ui/types';
import type { UiCopy } from '../../../../ui/copy/types';
import type { CaseStatus, Office } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL, PERSONAS } from '../../../../ui/fixtures/org/people';
import { DEMO_TODAY, formatDay } from '../../../../ui/fixtures/org/clock';
import {
  CANALS, CASE_TAG, KIND_TYPE, PROGRAM_NAME, STATUS_LABEL, SUPPLIERS, SUPPLIER_STATE_LABEL, TABLE_COLUMNS, TABLE_METAS,
} from '../../../../ui/fixtures/data';
import type { DemoState } from '../../store/state';
import { findLiveCase } from '../../store/cases';
import { isCaseTable, isUrgentDay, shortDay, type EngineRow, type Group } from './engine';

export const STATUS_TONE: Record<CaseStatus, Tone> = { 'da-confermare': 'violet', 'in-lavorazione': 'blue', 'in-attesa': 'amber', chiusa: 'green' };
export const STATUS_ORDER: CaseStatus[] = ['da-confermare', 'in-lavorazione', 'in-attesa', 'chiusa'];  // allow-italian: id of the fixture data, not shown

export const tableMeta = (id: string) => TABLE_METAS.find((t) => t.id === id);

/** The columns a table can be grouped by. */
export function groupColumns(table: string): string[] {
  if (isCaseTable(table)) return ['tipo', 'stato', 'ufficio'];  // allow-italian: id of the fixture data, not shown
  if (table === 'contribuenti') return ['comune'];
  if (table === 'canali') return ['tipo'];
  return ['anagrafica'];
}

/** The columns of a table that can be filtered by a choice. */
export function filterColumns(table: string): string[] {
  if (isCaseTable(table)) return ['tipo', 'stato', 'ufficio', 'scadenza'];  // allow-italian: id of the fixture data, not shown
  return groupColumns(table);
}

/** The words for a raw value of a column. */
export function valueLabel(col: string, value: string | number): string {
  const v = String(value);
  if (col === 'stato') return STATUS_LABEL[v as CaseStatus] ?? v;  // allow-italian: id of the fixture data, not shown
  if (col === 'ufficio') return OFFICE_LABEL[v as Office] ?? v;
  if (col === 'tipo') {
    const hit = Object.values(KIND_TYPE).find((t) => t?.letter === v);
    return hit ? `${hit.letter} · ${hit.label}` : v;
  }
  if (col === 'anagrafica') return SUPPLIER_STATE_LABEL[v as keyof typeof SUPPLIER_STATE_LABEL] ?? v;
  return v;
}

const columnLabel = (table: string, col: string) => TABLE_COLUMNS[table]?.find((c) => c.id === col)?.label ?? col;
export { columnLabel };

function cellsOf(table: string, r: EngineRow): Record<string, CellModel> {
  const v = r.values;
  const text = (t: string | number, tone?: Tone): CellModel => (t === '' ? { kind: 'empty' } : { kind: 'text', text: String(t), tone });
  if (isCaseTable(table)) {
    const status = v.stato as CaseStatus;
    const day = v.scadenza as string;
    const kindValue = String(v.tipo);
    return {
      oggetto: { kind: 'title', text: String(v.oggetto) },
      tipo: kindValue ? { kind: 'type', letter: kindValue, field: 'legal' } : { kind: 'empty' },
      stato: { kind: 'status', text: STATUS_LABEL[status], tone: STATUS_TONE[status], waiting: status === 'in-attesa' },
      ufficio: text(valueLabel('ufficio', String(v.ufficio))),
      contribuente: v.contribuente ? { kind: 'link', field: { kind: 'record', name: String(v.contribuente) } } : { kind: 'empty' },
      protocollo: v.protocollo ? { kind: 'link', field: { kind: 'number', name: String(v.protocollo) } } : { kind: 'empty' },
      scadenza: text(shortDay(day), isUrgentDay(day) ? 'red' : undefined),
    };
  }
  if (table === 'contribuenti') {
    return {
      nome: { kind: 'title', text: String(v.nome) },
      codice: { kind: 'link', field: { kind: 'record', name: String(v.codice) } },
      comune: text(String(v.comune)),
      pratiche: text(String(v.pratiche)),
      ultima: text(shortDay(v.ultima as string)),
    };
  }
  if (table === 'canali') {
    return { nome: { kind: 'title', text: String(v.nome) }, tipo: text(String(v.tipo)), comune: text(String(v.comune)), pratiche: text(String(v.pratiche)), fonte: text(String(v.fonte)) };
  }
  const hold = v.anagrafica === 'hold';
  return {
    nome: { kind: 'title', text: String(v.nome) },
    programma: { kind: 'link', field: { kind: 'link', name: PROGRAM_NAME[String(v.programma)] ?? String(v.programma) } },
    iban: text(String(v.iban)),
    dal: text(String(v.dal)),
    fatture: text(String(v.fatture)),
    anagrafica: { kind: 'status', text: valueLabel('anagrafica', String(v.anagrafica)), tone: hold ? 'amber' : 'green', waiting: hold },
  };
}

/** The label of a group of rows: the type with its name, the state, the office. */
export function groupTitle(col: string, key: string, countText: string): string {
  return `${key ? valueLabel(col, key) : '·'} · ${countText}`;
}

export function gridModelOf(table: string, groups: Group[], groupCol: string | null, addedBadge: string, groupCount: (n: number) => string): GridModel {
  return {
    columns: (TABLE_COLUMNS[table] ?? []).filter((c) => !c.panelOnly).map((c) => ({ id: c.id, label: c.label, width: c.width, sortable: c.sortable })),
    groups: groups.map((g) => ({
      id: g.key || 'all',
      label: groupCol ? groupTitle(groupCol, g.key, groupCount(g.rows.length)) : '',
      rows: g.rows.map((r): GridRow => ({
        id: r.id,
        cells: cellsOf(table, r),
        unread: r.unread,
        badge: r.added ? addedBadge : undefined,
        opens: Boolean(r.caseId) && !r.added,
      })),
    })),
  };
}

export function boardOf(table: string, rows: EngineRow[]): StatusColumnModel[] {
  if (isCaseTable(table)) {
    return STATUS_ORDER.map((s) => ({
      id: s,
      label: STATUS_LABEL[s],
      tone: STATUS_TONE[s],
      cards: rows.filter((r) => r.values.stato === s).map((r) => ({
        id: r.id,
        title: String(r.values.oggetto),
        detail: [valueLabel('ufficio', String(r.values.ufficio)), r.values.tipo].filter(Boolean).join(' · '),
        deadline: shortDay(r.values.scadenza as string) || undefined,
        urgent: isUrgentDay(r.values.scadenza as string),
      })),
    }));
  }
  return (['ok', 'hold'] as const).map((s) => ({
    id: s,
    label: valueLabel('anagrafica', s),
    tone: s === 'ok' ? 'green' : 'amber',
    cards: rows.filter((r) => r.values.anagrafica === s).map((r) => ({ id: r.id, title: String(r.values.nome), detail: String(r.values.iban) })),
  }));
}

const CHART_TONE: Tone[] = ['blue', 'violet', 'green', 'amber', 'pink', 'red', 'neutral'];

export function barsOf(rows: EngineRow[], col: string): ChartBarModel[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(String(r.values[col] ?? ''), (counts.get(String(r.values[col] ?? '')) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, value], i) => ({
    id: key,
    label: valueLabel(col, key) || '·',
    value,
    tone: col === 'stato' ? STATUS_TONE[key as CaseStatus] ?? 'neutral' : CHART_TONE[i % CHART_TONE.length],  // allow-italian: id of the fixture data, not shown
  }));
}

/** What a cell says, as plain text, for the CSV. */
export function cellText(cell: CellModel): string {
  switch (cell.kind) {
    case 'title': case 'text': case 'status': return cell.text;
    case 'link': return cell.field.name;
    case 'type': return cell.letter;
    case 'empty': return '';
  }
}

function eventWhen(at: string): string {
  const [day, time] = at.split(' ');
  return day === DEMO_TODAY ? time : `${day.slice(8)}/${day.slice(5, 7)}`;
}

/** The side panel of a row. Returns undefined when the row is gone (a filter, another person). */
export function peekOf(table: string, r: EngineRow, state: DemoState, copy: UiCopy): PeekModel | undefined {
  const p = copy.dataMore.peek;
  if (r.caseId) {
    const c = findLiveCase(state, r.caseId);
    if (!c) return undefined;
    const person = PERSONAS.find((x) => x.id === c.assignee);
    const day = String(r.values.scadenza ?? '');
    const nearest = c.deadlines.find((d) => d.date === day);
    const type = KIND_TYPE[c.kind];
    return {
      id: r.id,
      tag: CASE_TAG(c.id),
      title: c.title,
      fields: [
        { label: p.type, value: type ? `${type.letter} · ${type.label}` : '' },
        { label: p.status, value: STATUS_LABEL[c.status] },
        { label: p.owner, value: person?.name ?? c.assignee, avatar: person ? { text: person.monogram, color: person.color } : undefined },
        { label: p.office, value: OFFICE_LABEL[c.office] },
        ...(day ? [{ label: p.nearest, value: `${formatDay(day)}${nearest ? ` · ${nearest.label.split(' ')[0].toLowerCase()}` : ''}`, tone: isUrgentDay(day) ? 'red' as const : undefined }] : []),
      ],
      linked: [
        ...(c.counterpart ? [{ id: 'counterpart', field: { kind: 'record' as const, name: p.counterpart }, value: c.counterpart }] : []),
        ...(c.amount !== undefined ? [{ id: 'amount', field: { kind: 'record' as const, name: p.amount }, value: copy.dataMore.format.euro(c.amount) }] : []),
        { id: 'deadlines', field: { kind: 'number' as const, name: p.deadlines }, value: String(c.deadlines.filter((d) => !d.id.startsWith('avviso')).length) },  // allow-italian: id of the fixture data, not shown
        { id: 'documents', field: { kind: 'file' as const, name: p.documents }, value: String(c.documents.length) },
      ],
      history: [...c.history].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3).map((e) => ({ text: e.what, when: eventWhen(e.at) })),
      openLabel: r.added ? undefined : p.open,
    };
  }
  if (r.added) {
    return {
      id: r.id, tag: CASE_TAG(r.id.replace(/\D/g, '') || r.id), title: String(r.values.oggetto), badge: copy.dataMore.grid.addedNow,
      fields: [
        { label: p.type, value: valueLabel('tipo', String(r.values.tipo)) },
        { label: p.status, value: STATUS_LABEL['in-lavorazione'] },
        { label: p.office, value: valueLabel('ufficio', String(r.values.ufficio)) },
      ],
      linked: [], history: [],
    };
  }
  const linked = (r.linkedCases ?? []).flatMap((id) => {
    const c = findLiveCase(state, id);
    return c ? [{ id: `case:${c.id}`, field: { kind: 'folder' as const, name: CASE_TAG(c.id) }, value: c.title }] : [];
  });
  const meta = tableMeta(table);
  if (table === 'contribuenti') {
    return {
      id: r.id, tag: meta?.label ?? table, title: String(r.values.nome),
      fields: [
        { label: p.code, value: String(r.values.codice) },
        { label: p.comune, value: String(r.values.comune) || p.none },
        { label: p.lastCase, value: shortDay(r.values.ultima as string) },
      ],
      linked, history: [],
    };
  }
  if (table === 'canali') {
    const k = CANALS.find((x) => x.id === r.id);
    return {
      id: r.id, tag: meta?.label ?? table, title: String(r.values.nome),
      fields: [
        { label: p.type, value: String(r.values.tipo) },
        { label: p.comune, value: String(r.values.comune) || p.none },
        { label: p.source, value: k?.source ?? '' },
      ],
      linked, history: [],
    };
  }
  const s = SUPPLIERS.find((x) => x.id === r.id);
  const hold = r.values.anagrafica === 'hold';
  return {
    id: r.id, tag: meta?.label ?? table, title: String(r.values.nome),
    fields: [
      { label: p.iban, value: String(r.values.iban) },
      { label: p.since, value: String(r.values.dal) },
      { label: p.registry, value: valueLabel('anagrafica', String(r.values.anagrafica)), tone: hold ? 'amber' : 'green' },
    ],
    linked: [...(hold ? [{ id: 'quarantine', field: { kind: 'bolt' as const, name: p.quarantine }, value: s?.note ?? '' }] : []), ...linked],
    history: [],
  };
}

