/**
 * c02: the test of everything. One row per flow (a new version in test gets
 * its own row beside the active one) and per piece that can change a result.
 * A flow's numbers come from the same evaluation as its own page (c01); a
 * robot passes while its connection is on (n16). «Collauda tutto» plays the (allow-italian: quotes the Italian interface)
 * rows in sequence and keeps a run for each.
 */
import type { ReactNode } from 'react';
import { flowSeed, flowsOf } from '../../../../ui/fixtures/org/flows';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { DEFAULT_APPROVER, TESTABLE_THINGS, type TestableThing } from '../../../../ui/fixtures/team';
import { TestAllScreen } from '../../../../ui/team/TestAllScreen';
import type { AttentionModel, TestAllFilter, TestAllModel, TestAllRowModel } from '../../../../ui/team/model';
import type { JobCardModel } from '../../../../ui/team/parts';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { CONNECTIONS_INITIAL, connectionOf, connectionState, type ConnectionsSlice } from './connectionState';
import { agoLabel } from './format';
import {
  TESTS_INITIAL, evaluate, flowCases, flowTrialRunning, isSettled, lastRunOf, outcomesOf, planOf, simulate, testedVersion, thingState,
  type TestRun, type TestsSlice,
} from './testing';
import { vaultSlice } from '../../store/vault';

const TOTAL_JOB = 'test-all';
const LIVE = '@live';

/** Where a piece that is not a flow opens: the flow that uses it, or the page that holds it. */
const THING_PATH: Record<string, string> = {
  'ai-tipo-pec': P.flowTest('pec'),
  'ai-righe-fattura': P.flowTest('fatture'),
  'rule-scadenze-ricorso': P.flowTest('pec'),
  'rule-canone': P.flowTest('concessioni'),
  'robot-halley': P.settings('persone'),
  'robot-prunes': P.settings('persone'),
  'robot-teamsystem': P.settings('persone'),
  'robot-traspare': P.settings('persone'),
  'data-ricorsi': P.data(),
  'proc-rimborso': P.knowledge(),
  'sys-anonimizzazione': P.settings('anonimizzazione'),
};

type RowState = 'active' | 'testing' | 'redo' | 'draft';

interface Row {
  id: string;
  name: string;
  kind: 'flow' | TestableThing['kind'];
  version: number;
  state: RowState;
  fixed: number;
  /** Percent, or null before the first test. */
  stability: number | null;
  /** ISO of the last test the reader ran, when there is one. */
  lastRunAt?: string;
  /** Days since the seed's last check, for a piece the reader did not test. */
  checkedDaysAgo: number;
  approvedBy: string;
  open: string;
  /** What to run: a flow (and whether it is the live version) or a piece. */
  target: { kind: 'flow'; flow: FlowSeed; live: boolean } | { kind: 'thing'; thing: TestableThing };
  /** Why it needs a look, when it does. */
  attention?: { why: string; kindOf: 'cases' | 'no-cases' | 'connection' | 'other'; path: string; count?: number };
}

function flowRows(tests: TestsSlice): Row[] {
  const rows: Row[] = [];
  for (const flow of flowsOf('nocera')) {
    const plan = planOf(flow);
    const activated = tests.stages[flow.id] === 'attivo';
    const outcomes = outcomesOf(flow, tests);
    const ev = evaluate(flow, tests, outcomes);
    const last = lastRunOf(tests, flow.id);
    const cases = flowCases(flow.id).length;
    if (plan || flow.status !== 'attivo') {
      // The same rule the sidebar footer counts with: a draft nobody tried is not a trial.
      const state: RowState = activated ? 'active' : flowTrialRunning(flow, tests) ? 'testing' : 'draft';
      rows.push({
        id: flow.id, name: flow.name, kind: 'flow', version: testedVersion(flow), state, fixed: cases,
        stability: flow.status === 'bozza' && !last ? null : ev.stability,
        lastRunAt: last?.at, checkedDaysAgo: 0, approvedBy: activated ? DEFAULT_APPROVER : '',
        open: P.flowTest(flow.id), target: { kind: 'flow', flow, live: false },
        attention: ev.unsettled.length > 0 && !activated
          ? { why: '', kindOf: 'cases', path: P.flowTest(flow.id), count: ev.unsettled.length }
          : undefined,
      });
    }
    if (flow.status === 'attivo' && !activated) {
      const liveLast = lastRunOf(tests, flow.id + LIVE);
      // A live flow with no fixed case stays live (the Flows list says so too), but has nothing to be stable against:
      // no stability figure, and it is listed as something to fix.
      const proven = cases > 0;
      rows.push({
        id: flow.id + LIVE, name: flow.name, kind: 'flow', version: flow.version, state: 'active', fixed: cases, stability: proven ? 100 : null,
        lastRunAt: liveLast?.at, checkedDaysAgo: 0, approvedBy: DEFAULT_APPROVER, open: P.flowTest(flow.id),
        target: { kind: 'flow', flow, live: true },
        attention: proven ? undefined : { why: '', kindOf: 'no-cases', path: P.flowTest(flow.id) },
      });
    }
  }
  return rows;
}

function thingRows(tests: TestsSlice, conns: ConnectionsSlice, ctx: ScreenCtx): Row[] {
  const t = ctx.copy.team.testAll;
  return TESTABLE_THINGS.map((thing) => {
    const state = thingState(thing, tests);
    const run = lastRunOf(tests, thing.id);
    const conn = thing.connection ? connectionOf(thing.connection) : undefined;
    const offline = conn ? connectionState(conn, conns, vaultSlice(ctx)[0]) !== 'connected' : false;
    // A connection that was broken and is on again (Halley after its new password): the robot's test is to redo, not its connection.
    const repaired = Boolean(conn && conn.state === 'error' && !offline && !run);
    const rowState: RowState = state === 'attivo' ? 'active' : state === 'collaudo' ? 'testing' : 'redo'; // allow-italian: state value compared by value, not shown
    return {
      id: thing.id,
      name: thing.name,
      kind: thing.kind,
      version: thing.version,
      state: rowState,
      fixed: thing.fixed,
      stability: run ? (run.failure ? null : thing.stability ?? 100) : thing.stability,
      lastRunAt: run?.at,
      checkedDaysAgo: thing.checkedDaysAgo,
      approvedBy: thing.approvedBy ?? '',
      open: THING_PATH[thing.id] ?? P.testAll(),
      target: { kind: 'thing', thing },
      attention: rowState === 'redo'
        ? {
          why: run?.failure ?? (offline && conn ? t.robotOffline(conn.name) : repaired && conn ? t.robotRetest(conn.name) : thing.lastFailure ?? ''),
          kindOf: thing.connection && !repaired ? 'connection' : 'other',
          path: THING_PATH[thing.id] ?? P.testAll(),
        }
        : undefined,
    };
  });
}

const STATE_TONE: Record<RowState, { tone: Tone; icon: 'ok' | 'near' | 'bad' | 'todo' }> = {
  active: { tone: 'green', icon: 'ok' },
  testing: { tone: 'amber', icon: 'near' },
  redo: { tone: 'red', icon: 'bad' },
  draft: { tone: 'neutral', icon: 'todo' },
};
const KIND_TONE: Record<string, Tone> = {
  flow: 'green', ai: 'violet', rule: 'blue', robot: 'pink', data: 'neutral', procedure: 'neutral', system: 'neutral',
};

export function testAllScreen(_p: Record<string, string>, ctx: ScreenCtx): ReactNode {
  const t = ctx.copy.team.testAll;
  const [tests, setTests] = ctx.slice<TestsSlice>('tests', TESTS_INITIAL);
  const [conns] = ctx.slice<ConnectionsSlice>('connections', CONNECTIONS_INITIAL);
  const [filter, setFilter] = ctx.ui<TestAllFilter>('team.testAll.filter', 'all');

  const rows = [...flowRows(tests), ...thingRows(tests, conns, ctx)];
  const stateOf = (r: Row) => r.state;
  const counts: Record<TestAllFilter, number> = {
    all: rows.length,
    testing: rows.filter((r) => stateOf(r) === 'testing').length,
    redo: rows.filter((r) => stateOf(r) === 'redo').length,
  };
  const visible = rows.filter((r) => (filter === 'all' ? true : filter === 'testing' ? r.state === 'testing' : r.state === 'redo'));

  /* A piece is run on its own, or all together: this is one piece. */
  const runRow = (r: Row): TestRun => {
    const base = { at: ctx.now, by: ctx.persona.id, outcomes: [] as TestRun['outcomes'] };
    if (r.target.kind === 'flow') {
      const { flow, live } = r.target;
      return { id: '', target: r.id, kind: 'flow', version: live ? flow.version : testedVersion(flow), ...base, outcomes: simulate(flow, tests.rules, live) };
    }
    const { thing } = r.target;
    const conn = thing.connection ? connectionOf(thing.connection) : undefined;
    const offline = conn ? connectionState(conn, conns, vaultSlice(ctx)[0]) !== 'connected' : false;
    return { id: '', target: thing.id, kind: 'thing', version: thing.version, ...base, failure: offline && conn ? t.robotOffline(conn.name) : undefined };
  };

  const commit = (made: TestRun[]) => {
    setTests((prev) => ({
      ...prev,
      runs: [...made.map((r, i) => ({ ...r, id: `run-${prev.runs.length + made.length - i}` })), ...prev.runs],
    }));
  };

  /* A run fails when a piece did not answer, or a case differs and the reader has not settled it. */
  const failureOf = (run: TestRun): boolean => {
    if (run.failure !== undefined) return true;
    const flow = flowSeed(run.target.replace(LIVE, ''));
    return flow ? run.outcomes.some((o) => !isSettled(o, flow, tests)) : false;
  };

  const runOne = (r: Row) => {
    const done = runRow(r);
    const caseCount = r.target.kind === 'flow' ? Math.max(1, flowCases(r.target.flow.id).length) : 1;
    const jobId = `test-one:${r.id}`;
    ctx.startJob({
      id: jobId,
      title: t.runningStep(r.name),
      steps: Array.from({ length: Math.min(caseCount, 6) }, (_, i) => ({ label: `${r.name} ${i + 1}`, ms: 360, fails: done.failure !== undefined && i === 0 })),
      onDone: (ok) => {
        commit([done]);
        const bad = !ok || failureOf(done);
        ctx.log(ctx.copy.team.test.log.finished(r.name, done.outcomes.filter((o) => o.pass).length, done.outcomes.length), 'test', P.testAll());
        ctx.toast({
          tone: bad ? 'warn' : 'ok',
          title: ctx.copy.team.test.job.toastTitle(r.name),
          body: done.failure ?? ctx.copy.team.test.job.toastBody(done.outcomes.filter((o) => o.pass).length, done.outcomes.length),
        });
      },
    });
  };

  const runAll = () => {
    const made = rows.map(runRow);
    ctx.startJob({
      id: TOTAL_JOB,
      title: t.runningTitle,
      steps: rows.map((r) => ({ label: t.runningStep(r.name), ms: 300 })),
      onDone: () => {
        commit(made);
        const fails = made.filter(failureOf).length;
        setTests((prev) => ({ ...prev, lastAll: { at: ctx.now, by: ctx.persona.id, ok: made.length - fails, fails } }));
        ctx.log(t.logFinished(made.length, fails), 'test', P.testAll());
        ctx.toast({ tone: fails === 0 ? 'ok' : 'warn', title: t.toastTitle, body: t.toastBody(made.length - fails, fails) });
      },
    });
  };

  const job = ctx.job(TOTAL_JOB);
  const jobModel: JobCardModel | undefined = job && job.status !== 'done'
    ? {
      title: t.runningTitle,
      status: job.status,
      progress: job.progress,
      current: job.current,
      detail: t.runningDetail(job.done.length, rows.length),
      done: job.done,
      failedTitle: ctx.copy.team.test.job.failedTitle,
      failedBody: ctx.copy.team.test.job.failedBody,
      retryLabel: ctx.copy.team.test.job.retry,
      onRetry: ctx.allow('run:tests', runAll),
    }
    : undefined;

  const rowModels: TestAllRowModel[] = visible.map((r) => {
    const st = STATE_TONE[r.state];
    const approved = r.approvedBy || ctx.copy.team.common.blank;
    const last = r.lastRunAt
      ? agoLabel(ctx.copy.team, r.lastRunAt, ctx.now)
      : r.state === 'draft' ? t.notTestedYet : r.checkedDaysAgo === 0 ? t.last.night : t.last.daysAgo(r.checkedDaysAgo);
    return {
      id: r.id,
      name: r.name,
      kind: t.kinds[r.kind],
      kindTone: KIND_TONE[r.kind] ?? 'neutral',
      version: r.version,
      state: { text: r.state === 'active' ? t.states.active : r.state === 'testing' ? t.states.testing : r.state === 'redo' ? t.states.redo : t.states.draft, ...st },
      fixed: String(r.fixed),
      stability: r.stability === null ? ctx.copy.team.common.blank : `${(Math.round(r.stability * 10) / 10).toString().replace('.', ',')}%`,
      last,
      approvedBy: approved,
      onOpen: () => ctx.go(r.open),
      running: ctx.job(`test-one:${r.id}`)?.status === 'running',
      onRun: job?.status === 'running' ? false : ctx.allow('run:tests', () => runOne(r)),
    };
  });

  const attention: AttentionModel[] = rows.flatMap((r): AttentionModel[] => {
    const a = r.attention;
    if (!a) return [];
    if (a.kindOf === 'no-cases') {
      return [{ id: r.id, title: t.noCasesTitle(r.name), why: t.noCasesWhy, actionLabel: t.openTest, onOpen: () => ctx.go(a.path) }];
    }
    if (a.kindOf === 'cases') {
      return [{
        id: r.id, title: t.failCases(a.count ?? 0, r.name), why: ctx.copy.team.test.criteria.states.unstable(a.count ?? 0),
        actionLabel: t.openTest, onOpen: () => ctx.go(a.path),
      }];
    }
    return [{
      id: r.id, title: r.name, why: t.failWhy(a.why), actionLabel: a.kindOf === 'connection' ? t.openConnection : t.openTest, onOpen: () => ctx.go(a.path),
    }];
  });

  const active = rows.filter((r) => r.state === 'active');
  const numeric = rows.map((r) => r.stability).filter((v): v is number => v !== null);
  const avg = numeric.length ? numeric.reduce((s, v) => s + v, 0) / numeric.length : 0;
  const fixedTotal = rows.reduce((s, r) => s + r.fixed, 0);
  const lastAll = tests.lastAll;

  const model: TestAllModel = {
    kpis: [
      { id: 'active', label: t.kpi.active.label, value: String(active.length), detail: t.kpi.active.detail },
      { id: 'testing', label: t.kpi.testing.label, value: String(counts.testing), detail: t.kpi.testing.detail, tone: 'amber' },
      { id: 'stability', label: t.kpi.stability.label, value: `${(Math.round(avg * 10) / 10).toString().replace('.', ',')}%`, detail: `${t.kpi.stability.detail} · ${ctx.copy.team.common.example}` },
      { id: 'fixed', label: t.kpi.fixed.label, value: String(fixedTotal), detail: t.kpi.fixed.detail },
    ],
    rows: rowModels,
    counts,
    filter,
    job: jobModel,
    attention,
    summary: lastAll ? (lastAll.fails === 0 ? t.summaryAllOk(lastAll.ok) : t.summaryWithFails(lastAll.ok, lastAll.fails)) : undefined,
  };

  return (
    <TestAllScreen
      model={model}
      copy={ctx.copy}
      onFilter={setFilter}
      onRunAll={job?.status === 'running' ? false : ctx.allow('run:tests', runAll)}
      phone={ctx.phone}
    />
  );
}

export const TEST_ALL_SCREEN: ScreenDef = {
  id: 'c02',
  path: '/collaudo',
  org: 'nocera',
  nav: 'flows',
  needs: 'view:flows',
  samples: [P.testAll()],
  title: (_p, ctx) => ctx.copy.team.testAll.crumb,
  render: testAllScreen,
};

