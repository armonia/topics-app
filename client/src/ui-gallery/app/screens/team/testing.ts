/**
 * How a flow is tested in the preview: the fixed cases are the past cases of
 * the example (`CASES`) that went through the flow, the expected result is
 * what the people decided, and the flow's result is simulated the same way
 * every time. A new version of a flow reads a case it was unsure of (a field
 * the AI read under 85%) differently, which is what a test is there to find;
 * a fixed rule or a decision of the reader clears it.
 *
 * Everything here is pure: the same cases, rules and decisions always give
 * the same outcomes, so two screens that ask cannot disagree.
 */
import type { CaseKind, CaseSeed, FlowSeed, Office } from '../../../../ui/fixtures/org/types';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import type { OrgKey } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { CASE_KIND_LABEL, KIND_CONFUSION, TEST_DAYS, TEST_PLANS, TESTABLE_THINGS, type TestPlan, type TestableThing } from '../../../../ui/fixtures/team';
import type { TestField } from '../../../../ui/copy/team';
import { formatDay } from './format';

/* ---------- what is stored ---------- */

export interface CaseOutcome {
  caseId: string;
  pass: boolean;
  field?: TestField;
  expected?: string;
  actual?: string;
  /** The three rounds of an unstable case: `A` is what the people decided. */
  rounds?: string[];
}

export interface TestRun {
  id: string;
  /** A flow id, or a thing id (`TESTABLE_THINGS`). */
  target: string;
  kind: 'flow' | 'thing';
  version: number;
  /** ISO date-time. */
  at: string;
  /** A persona id. */
  by: string;
  outcomes: CaseOutcome[];
  /** Why a thing failed, when it did. */
  failure?: string;
}

export interface FixedRule {
  flow: string;
  kind: CaseKind;
  office: Office;
}

export type Stage = 'approvazione' | 'attivo'; // allow-italian: state value compared by value, not shown

/** The slice `tests`: what the readers did to the tests. */
export interface TestsSlice {
  runs: TestRun[];
  rules: FixedRule[];
  /** `flow`: the flow was right and the case is settled; `person`: the person was right (a rule is added too). */
  decisions: Record<string, 'flow' | 'person'>;
  /** Where a flow's version in test has got to, once somebody moved it. */
  stages: Record<string, Stage>;
  /** Who asked for the approval, by flow. */
  requestedBy: Record<string, string>;
  /** The last «Collauda tutto». (allow-italian: quotes the Italian interface) */
  lastAll?: { at: string; by: string; ok: number; fails: number };
}

export const TESTS_INITIAL: TestsSlice = { runs: [], rules: [], decisions: {}, stages: {}, requestedBy: {} };

/* ---------- the fixed cases of a flow ---------- */

export const flowCases = (flowId: string): CaseSeed[] => CASES.filter((c) => c.flow === flowId);

/** A case the AI was unsure of: a field read under 85%. */
export const isHard = (c: CaseSeed): boolean => c.fields.some((f) => f.confidence < 85);

/** Is the flow tested as a new version (or a draft) rather than as it runs? */
export const isTestingVersion = (flow: FlowSeed): boolean => TEST_PLANS[flow.id] !== undefined || flow.status !== 'attivo'; // allow-italian: state value compared by value, not shown

export const planOf = (flow: FlowSeed): TestPlan | undefined => TEST_PLANS[flow.id];

/** The version a test of this flow is about. */
export const testedVersion = (flow: FlowSeed): number => planOf(flow)?.version ?? flow.version;

function ruled(rules: FixedRule[], flowId: string, kind: CaseKind): boolean {
  return rules.some((r) => r.flow === flowId && r.kind === kind);
}

/** What the people decided for a case, as three values. */
export function expectedOf(c: CaseSeed): Record<TestField, string> {
  const first = c.deadlines[0];
  return {
    kind: CASE_KIND_LABEL[c.kind],
    office: OFFICE_LABEL[c.office],
    deadline: first ? formatDay(first.date) : '',
  };
}

/** Plays every fixed case of the flow once. `rules` are the fixed rules in force when it ran; `asActive` plays the version that is live, not the one in test. */
export function simulate(flow: FlowSeed, rules: FixedRule[], asActive = false): CaseOutcome[] {
  const testing = !asActive && isTestingVersion(flow);
  return flowCases(flow.id).map((c) => {
    const confused = KIND_CONFUSION[c.kind];
    if (testing && confused && isHard(c) && !ruled(rules, flow.id, c.kind)) {
      return {
        caseId: c.id, pass: false, field: 'kind', expected: CASE_KIND_LABEL[c.kind], actual: CASE_KIND_LABEL[confused], rounds: ['A', 'A', 'B'],
      };
    }
    return { caseId: c.id, pass: true };
  });
}

/** An outcome the reader settled by a rule or a decision counts as passing. */
export function isSettled(o: CaseOutcome, flow: FlowSeed, tests: TestsSlice): boolean {
  if (o.pass) return true;
  const c = CASES.find((x) => x.id === o.caseId);
  if (!c) return false;
  return ruled(tests.rules, flow.id, c.kind) || tests.decisions[o.caseId] === 'flow';
}

/* ---------- the criteria ---------- */

/** The last run of a target, the newest first in `runs`. */
export const lastRunOf = (tests: TestsSlice, target: string): TestRun | undefined => tests.runs.find((r) => r.target === target);

/** The outcomes on show: the last run's, or last night's check (the same simulation) when nobody ran one. */
export function outcomesOf(flow: FlowSeed, tests: TestsSlice, run?: TestRun): CaseOutcome[] {
  if (run) return run.outcomes;
  const last = lastRunOf(tests, flow.id);
  return last ? last.outcomes : simulate(flow, []);
}

/** Seconds of the slowest step: an estimate by what kind of step it is. */
const STEP_SECONDS: Record<string, number> = { robot: 52, program: 40, ai: 31, classify: 12, send: 6, view: 3, rule: 2, person: 0 };
export function slowestStep(flow: FlowSeed): number {
  return flow.steps.reduce((m, s) => Math.max(m, STEP_SECONDS[s.kind] ?? 0), 0);
}

export type CriterionState = 'ok' | 'near' | 'bad' | 'todo';

export interface Criterion {
  id: 'tried' | 'agree' | 'critical' | 'stable' | 'hard' | 'slow';
  required: string;
  now: string;
  state: CriterionState;
  /** A count for the state's wording (unstable cases, errors, cases that fail). */
  n?: number;
  estimate?: boolean;
}

export interface Evaluation {
  criteria: Criterion[];
  ready: boolean;
  /** Settled or not, by outcome. */
  fails: CaseOutcome[];
  unsettled: CaseOutcome[];
  total: number;
  tried: number;
  triedRequired: number;
  /** Stability in percent, over the cases tried. */
  stability: number;
  day: number;
  of: number;
}

const pct = (v: number) => `${(Math.round(v * 10) / 10).toString().replace('.', ',')}%`;

/** The criteria a version has to pass, from the outcomes of a run. */
export function evaluate(flow: FlowSeed, tests: TestsSlice, outcomes: CaseOutcome[]): Evaluation {
  const plan = planOf(flow);
  const of = plan?.of ?? TEST_DAYS;
  const day = plan?.day ?? of;
  const total = outcomes.length;
  const fails = outcomes.filter((o) => !o.pass);
  const unsettled = fails.filter((o) => !isSettled(o, flow, tests));
  const shadow = Math.round((flow.perMonth * day) / 30);
  const tried = shadow + total;
  const triedRequired = Math.max(3, Math.min(200, Math.round((flow.perMonth * of) / 30 * 0.7 / 10) * 10));
  const triedState: CriterionState = tried >= triedRequired ? 'ok' : tried >= triedRequired * 0.8 ? 'near' : 'bad';
  const critical = unsettled.filter((o) => o.field === 'office' || o.field === 'deadline').length;
  const unstable = unsettled.filter((o) => o.rounds && new Set(o.rounds).size > 1).length;
  const agreeRate = tried > 0 ? ((tried - unsettled.length) / tried) * 100 : 100;
  const stableRate = tried > 0 ? ((tried - unstable) / tried) * 100 : 100;
  const slow = slowestStep(flow);
  const hardPassed = total - unsettled.length;
  const criteria: Criterion[] = [
    { id: 'tried', required: String(triedRequired), now: String(tried), state: triedState, estimate: true },
    { id: 'agree', required: '97', now: pct(agreeRate), state: agreeRate >= 97 ? 'ok' : agreeRate >= 90 ? 'near' : 'bad', n: unsettled.length },
    { id: 'critical', required: '0', now: String(critical), state: critical === 0 ? 'ok' : 'bad', n: critical },
    { id: 'stable', required: '100', now: pct(stableRate), state: unstable === 0 ? 'ok' : 'bad', n: unstable },
    { id: 'hard', required: String(total), now: String(hardPassed), state: total === 0 ? 'todo' : hardPassed === total ? 'ok' : 'bad', n: unsettled.length },
    { id: 'slow', required: '90', now: String(slow), state: slow < 90 ? 'ok' : 'bad', estimate: true },
  ];
  return {
    criteria, ready: criteria.every((c) => c.state === 'ok'), fails, unsettled, total, tried, triedRequired, stability: stableRate, day, of,
  };
}

/* ---------- where a version is ---------- */

export type StageIndex = 0 | 1 | 2 | 3 | 4;

/** The stepper position: 0 draft, 1 cases, 2 test, 3 approval, 4 live. A draft is at its cases until it was tried once. */
export function stageOf(flow: FlowSeed, tests: TestsSlice): StageIndex {
  const moved = tests.stages[flow.id];
  if (moved === 'attivo') return 4; // allow-italian: state value compared by value, not shown
  if (moved === 'approvazione') return 3;
  if (flow.status === 'bozza') return lastRunOf(tests, flow.id) ? 2 : 1;
  if (planOf(flow) || flow.status === 'collaudo') return 2;
  return 4;
}

/* ---------- things that are not flows (c02) ---------- */

/**
 * A thing's state, from its seed and the last test it had in the preview. A
 * robot passes while its connection is on; the rest passes as it did.
 */
export function thingState(thing: TestableThing, tests: TestsSlice): 'attivo' | 'collaudo' | 'da-rifare' { // allow-italian: state value compared by value, not shown
  const run = lastRunOf(tests, thing.id);
  if (!run) return thing.status;
  if (run.failure) return 'da-rifare';
  return thing.status === 'collaudo' ? 'collaudo' : 'attivo'; // allow-italian: state value compared by value, not shown
}

/* ---------- trials running now (the sidebar footer and the «In collaudo» of c02) ---------- */

/**
 * Is a trial running for this flow right now: a new version beside the active one, or a flow that is not live yet and
 * was tried at least once? A draft nobody tried is not a trial; a version already activated has finished its.
 */
export function flowTrialRunning(flow: FlowSeed, tests: TestsSlice): boolean {
  if (tests.stages[flow.id] === 'attivo') return false; // allow-italian: state value compared by value, not shown
  if (flow.status === 'bozza' && !lastRunOf(tests, flow.id)) return false; // allow-italian: state value compared by value, not shown
  return isTestingVersion(flow);
}

/**
 * The trials running for the given organizations: flows and new versions in test, plus the pieces (a procedure) in
 * test, which belong to the Consorzio. One source: the footer of the sidebar and the «In collaudo» count of c02 both
 * ask this, so they cannot disagree.
 */
export function trialsRunning(tests: TestsSlice, orgs: OrgKey[]): number {
  const flows = FLOWS.filter((f) => orgs.includes(f.org) && flowTrialRunning(f, tests)).length;
  const things = orgs.includes('nocera') ? TESTABLE_THINGS.filter((t) => thingState(t, tests) === 'collaudo').length : 0; // allow-italian: state value compared by value, not shown
  return flows + things;
}
