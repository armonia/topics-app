/**
 * The fields of a table with their rules and calculations (x02), and the test
 * of a rule on the example rows: which rows pass and which fail. A field of
 * the fixtures can be edited in the preview; the edits and the fields added
 * by hand live in two slices and are applied over the seeds here.
 */
import type { CaseSeed } from '../../../../ui/fixtures/org/types';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { addDays, dueDate, daysFromToday, formatDay } from '../../../../ui/fixtures/org/clock';
import { CANALS, FIELD_SEEDS, KIND_TYPE, SUPPLIERS, type FieldSeed } from '../../../../ui/fixtures/data';
import { protocolOf } from '../../store/cases';
import { taxpayerCode, hasTaxpayer } from './engine';

export type FieldEdits = Record<string, Partial<FieldSeed>>;
export type FieldsAdded = Record<string, FieldSeed[]>;

export const editKey = (table: string, field: string) => `${table}.${field}`;

/** The fields of a table as the reader left them. */
export function fieldsOf(table: string, edits: FieldEdits, added: FieldsAdded): FieldSeed[] {
  const seeds = FIELD_SEEDS[table] ?? [];
  const merged = seeds.map((s) => ({ ...s, ...(edits[editKey(table, s.id)] ?? {}) }));
  const extra = (added[table] ?? []).map((s) => ({ ...s, ...(edits[editKey(table, s.id)] ?? {}) }));
  return [...merged, ...extra];
}

export interface RuleFailure {
  /** The row the value is in. */
  id: string;
  caseId?: string;
  title: string;
  value: string;
  /** What the rule expected instead, when it computes it. */
  expected?: string;
  why: 'missing' | 'format' | 'list' | 'range' | 'future' | 'calc';
}

export interface RuleResult {
  fieldId: string;
  total: number;
  passed: number;
  failures: RuleFailure[];
  /** No example row carries this field, so there is nothing to test. */
  untestable: boolean;
}

const isReminder = (id: string) => id.startsWith('avviso');  // allow-italian: id of the fixture data, not shown

function overlapsAugust(from: string, days: number): boolean {
  const year = Number(from.slice(0, 4));
  for (const y of [year, year + 1]) {
    const start = `${y}-08-01`;
    const end = `${y}-08-31`;
    const last = addDays(from, days);
    if (from <= end && last >= start) return true;
  }
  return false;
}

/** The term a calculated field gives for a deadline that runs from `from`. */
export function computeTerm(calc: NonNullable<FieldSeed['calc']>, from: string): string {
  const days = calc.augustPause && overlapsAugust(from, calc.days) ? calc.days + 31 : calc.days;
  return dueDate(from, days, calc.rollsOver);
}

const findDeadline = (c: CaseSeed, key: string) =>
  c.deadlines.find((d) => !isReminder(d.id) && (d.id.includes(key) || d.label.toLowerCase().includes(key)));

function sourceValue(source: string, c: CaseSeed): string | undefined {
  const [kind, arg] = source.split(':');
  switch (kind) {
    case 'case.id': return c.id;
    case 'case.type': return KIND_TYPE[c.kind]?.letter;
    case 'case.office': return c.office;
    case 'case.protocol': return protocolOf(c)?.number;
    case 'case.counterpart': return hasTaxpayer(c) || c.kind === 'fattura' ? c.counterpart : undefined;
    case 'case.amount': return c.amount === undefined ? undefined : String(c.amount);
    case 'case.assignee': return c.assignee;
    case 'case.deadlines': return String(c.deadlines.filter((d) => !isReminder(d.id)).length);
    case 'case.documents': return String(c.documents.length);
    case 'case.subject': return c.subject;
    case 'case.comune': return c.comune ?? c.parcel?.comune;
    case 'case.canal': return c.parcel?.canale;
    case 'case.judicial': return c.kind === 'ricorso' ? 'yes' : 'no';
    case 'case.notified': return (findDeadline(c, 'costituz') ?? c.deadlines.find((d) => !isReminder(d.id)))?.from;
    case 'case.field': {
      const hit = c.fields.find((f) => f.id === arg || f.label.toLowerCase().includes(arg ?? '#'));
      return hit?.value;
    }
    default: return undefined;
  }
}

/** The kinds of case each table of cases holds. */
function casesOfTable(table: string): CaseSeed[] {
  const kinds: Record<string, string[] | undefined> = {
    pratiche: undefined, ricorsi: ['ricorso'], fatture: ['fattura'], 'richieste-irrigue': ['irrigazione'], concessioni: ['concessione'],
  };
  return CASES.filter((c) => c.org === 'nocera' && (!kinds[table] || kinds[table]?.includes(c.kind)));
}

interface Candidate {
  id: string;
  caseId?: string;
  title: string;
  value: string | undefined;
  seed?: CaseSeed;
}

function candidates(table: string, field: FieldSeed): Candidate[] {
  const [kind] = field.source.split('.');
  if (kind === 'supplier') {
    return SUPPLIERS.map((s) => ({
      id: s.id,
      title: s.name,
      value: field.source === 'supplier.iban' ? s.iban : field.source === 'supplier.since' ? String(s.since) : s.name,
    }));
  }
  if (kind === 'canal') {
    return CANALS.map((k) => ({
      id: k.id,
      title: k.name,
      value: field.source === 'canal.kind' ? k.kind : field.source === 'canal.comune' ? k.comune : k.name,
    }));
  }
  if (kind === 'taxpayer') {
    return casesOfTable('pratiche').filter(hasTaxpayer).map((c) => ({
      id: c.id,
      caseId: c.id,
      title: c.counterpart,
      value: field.source === 'taxpayer.code' ? taxpayerCode(c.id) : field.source === 'taxpayer.comune' ? c.comune ?? c.parcel?.comune : c.counterpart,
    }));
  }
  return casesOfTable(table).map((c) => ({ id: c.id, caseId: c.id, title: c.title, value: sourceValue(field.source, c), seed: c }));
}

function checkValue(field: FieldSeed, value: string): RuleFailure['why'] | null {
  const rule = field.rule;
  switch (rule.kind) {
    case 'format': return rule.pattern && !new RegExp(rule.pattern).test(value) ? 'format' : null;
    case 'list': {
      const list = rule.list ?? [];
      return list.some((l) => value.toLowerCase().includes(l.toLowerCase())) ? null : 'list';
    }
    case 'range': return rule.min !== undefined && Number(value) < rule.min ? 'range' : null;
    case 'notFuture': return value && daysFromToday(value) > 0 ? 'future' : null;
    default: return null;
  }
}

/** Runs the rule of a field on every example row of its table. */
export function testField(table: string, field: FieldSeed): RuleResult {
  const rows = candidates(table, field);
  const failures: RuleFailure[] = [];
  let testable = 0;
  const formula = field.type === 'computedDate' ? field.calc : undefined;
  for (const r of rows) {
    if (formula) {
      const d = r.seed ? findDeadline(r.seed, formula.deadline) : undefined;
      if (!d || formula.direction === -1) continue;
      testable += 1;
      const expected = computeTerm(formula, d.from);
      if (expected !== d.date) failures.push({ id: r.id, caseId: r.caseId, title: r.title, value: formatDay(d.date), expected: formatDay(expected), why: 'calc' });
      continue;
    }
    if (r.value === undefined || r.value === '') {
      if (field.required && field.rule.kind !== 'none') {
        testable += 1;
        failures.push({ id: r.id, caseId: r.caseId, title: r.title, value: '', why: 'missing' });
      }
      continue;
    }
    if (field.rule.kind === 'none' && !field.required) continue;
    testable += 1;
    if (field.rule.kind === 'exists' || field.rule.kind === 'required') continue;
    const why = checkValue(field, r.value);
    if (why) failures.push({ id: r.id, caseId: r.caseId, title: r.title, value: r.value, why });
  }
  return { fieldId: field.id, total: testable, passed: testable - failures.length, failures, untestable: testable === 0 };
}
