/**
 * The scores of q01: computed from the example cases where a control can be
 * run on them, a declared example percentage where it cannot (the screen says
 * which). A control the reader switches off stops weighing on its dimension.
 */
import type { CaseSeed } from '../../../../ui/fixtures/org/types';
import { daysFromToday, dueDate } from '../../../../ui/fixtures/org/clock';
import { CHECKS, DIMENSION_IDS, QUARANTINE, type CheckSeed, type DimensionId } from '../../../../ui/fixtures/quality';
import type { DemoState } from '../../store/state';
import { orgCases } from '../../store/cases';

export interface CheckResult {
  check: CheckSeed;
  /** 0-100, null when there is nothing to measure. */
  pct: number | null;
  /** Rows measured; absent for a declared example. */
  total?: number;
  passed?: number;
  computed: boolean;
  failing: string[];
  on: boolean;
}

const isReminder = (id: string) => id.startsWith('avviso');  // allow-italian: id of the fixture data, not shown

type Evaluator = (cases: CaseSeed[], live: Map<string, boolean>) => { total: number; passed: number; failing: string[] };

const EVALUATORS: Record<string, Evaluator> = {
  amount: (cases) => {
    const rows = cases.filter((c) => c.amount !== undefined);
    const bad = rows.filter((c) => (c.amount ?? 0) < 0);
    return { total: rows.length, passed: rows.length - bad.length, failing: bad.map((c) => c.id) };
  },
  notified: (cases) => {
    const rows = cases.flatMap((c) => c.deadlines.filter((d) => !isReminder(d.id)).map((d) => ({ c, d })));
    const bad = rows.filter(({ d }) => daysFromToday(d.from) > 0);
    return { total: rows.length, passed: rows.length - bad.length, failing: bad.map(({ c }) => c.id) };
  },
  required: (cases) => {
    let total = 0;
    let passed = 0;
    const failing: string[] = [];
    for (const c of cases) {
      const filled = [c.office, c.flow, c.subject, c.counterpart, c.assignee].filter(Boolean).length;
      total += 5;
      passed += filled;
      if (filled < 5) failing.push(c.id);
    }
    return { total, passed, failing };
  },
  protocol: (cases) => {
    const rows = cases.filter((c) => c.status !== 'da-confermare');
    const bad = rows.filter((c) => !c.protocol);
    return { total: rows.length, passed: rows.length - bad.length, failing: bad.map((c) => c.id) };
  },
  deadlines: (cases) => {
    const rows = cases.flatMap((c) => c.deadlines.map((d) => ({ c, d })));
    const bad = rows.filter(({ d }) => dueDate(d.from, d.days, d.rollsOver) !== d.date);
    return { total: rows.length, passed: rows.length - bad.length, failing: bad.map(({ c }) => c.id) };
  },
  duplicates: (cases) => {
    const numbers = cases.map((c) => c.protocol?.number).filter((n): n is string => Boolean(n));
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const n of numbers) (seen.has(n) ? dup : seen).add(n);
    return { total: numbers.length, passed: numbers.length - dup.size, failing: cases.filter((c) => c.protocol && dup.has(c.protocol.number)).map((c) => c.id) };
  },
  confidence: (cases, live) => {
    const rows = cases.flatMap((c) => c.fields.map((f) => ({ c, f })));
    const bad = rows.filter(({ c, f }) => f.confidence < 85 && !live.get(`${c.id}.${f.id}`));
    return { total: rows.length, passed: rows.length - bad.length, failing: [...new Set(bad.map(({ c }) => c.id))] };
  },
  source: (cases) => {
    const rows = cases.flatMap((c) => c.fields.map((f) => ({ c, f })));
    const bad = rows.filter(({ f }) => !f.source.doc || !f.source.highlight);
    return { total: rows.length, passed: rows.length - bad.length, failing: bad.map(({ c }) => c.id) };
  },
  norm: (cases) => {
    const rows = cases.flatMap((c) => c.deadlines.map((d) => ({ c, d })));
    const bad = rows.filter(({ d }) => !d.rule || !d.calc);
    return { total: rows.length, passed: rows.length - bad.length, failing: bad.map(({ c }) => c.id) };
  },
};

export interface QualityNumbers {
  results: CheckResult[];
  dimensions: Array<{ id: DimensionId; pct: number | null; checks: CheckResult[] }>;
  overall: number | null;
  rowsMeasured: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeQuality(state: DemoState, off: string[]): QualityNumbers {
  const cases = orgCases(state, 'nocera');
  const live = new Map<string, boolean>();
  for (const c of cases) for (const k of Object.keys(c.live.values ?? {})) live.set(`${c.id}.${k}`, true);
  const seeds = cases.map((c) => c as CaseSeed);
  const results: CheckResult[] = CHECKS.map((check) => {
    const on = !off.includes(check.id);
    if (check.evaluator) {
      const r = EVALUATORS[check.evaluator](seeds, live);
      return {
        check, on, computed: true, total: r.total, passed: r.passed, failing: r.failing,
        pct: r.total ? round1((r.passed / r.total) * 100) : null,
      };
    }
    return { check, on, computed: false, pct: check.declaredPct ?? null, failing: [] };
  });
  const dimensions = DIMENSION_IDS.map((id) => {
    const checks = results.filter((r) => r.check.dimension === id);
    const active = checks.filter((r) => r.on && r.pct !== null);
    const pct = active.length ? round1(active.reduce((s, r) => s + (r.pct ?? 0), 0) / active.length) : null;
    return { id, pct, checks };
  });
  const scored = dimensions.filter((d) => d.pct !== null);
  const overall = scored.length ? round1(scored.reduce((s, d) => s + (d.pct ?? 0), 0) / scored.length) : null;
  return { results, dimensions, overall, rowsMeasured: seeds.length };
}

/** The decision made on a quarantined item (slice `quarantine`). */
export interface QuarantineDecision {
  status: 'confirmed' | 'rejected' | 'asked';
  at: string;
  by: string;
  reason?: string;
  receipt?: { title: string; lines: string[] };
}

export type QuarantineDecisions = Record<string, QuarantineDecision>;

/** Items still waiting on a person: stopped and not decided (a question to the supplier leaves it stopped). */
export function pendingItems(decisions: QuarantineDecisions) {
  return QUARANTINE.filter((q) => !q.settled && decisions[q.id]?.status !== 'confirmed' && decisions[q.id]?.status !== 'rejected');
}
