/**
 * c01: the test of one flow. The fixed cases are the past cases of the
 * example that went through it; «Avvia il collaudo» plays them one by one with (allow-italian: quotes the Italian interface)
 * visible progress, and the results stay in the slice `tests` (history, rules,
 * decisions, the stage of the version) so every other screen reads the same.
 */
import { Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { flowSeed } from '../../../../ui/fixtures/org/flows';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { CRITERIA_AGREED_WITH, DEFAULT_AGREED_WITH, DEFAULT_APPROVER, CASE_KIND_LABEL } from '../../../../ui/fixtures/team';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import type { MenuItemModel } from '../../../../ui/primitives/Menu';
import { FlowTestScreen } from '../../../../ui/team/FlowTestScreen';
import type { CaseFilter, CaseOutcomeKind, DiffRowModel, FlowTestActions, FlowTestModel, HistoryRowModel, TestCaseRowModel } from '../../../../ui/team/model';
import type { JobCardModel } from '../../../../ui/team/parts';
import type { Tone } from '../../../../ui/types';
import type { Params, ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import { agoLabel, personName, timeOf, whenLabel } from './format';
import {
  TESTS_INITIAL, evaluate, expectedOf, flowCases, isHard, isSettled, outcomesOf, planOf, simulate, stageOf, testedVersion,
  type CaseOutcome, type FixedRule, type Stage, type TestRun, type TestsSlice,
} from './testing';

const NIGHT = 'night';

function notFound(ctx: ScreenCtx): ReactNode {
  const n = ctx.copy.app.notFound;
  return (
    <EmptyState icon={Workflow} title={n.title}>{n.body}</EmptyState>
  );
}

/** The version-in-test line: «in collaudo · giorno 4 di 7», or where else it stands. (allow-italian: quotes the Italian interface) */
function statusOf(flow: FlowSeed, stage: number, ctx: ScreenCtx): { text: string; tone: Tone } {
  const t = ctx.copy.team.test;
  const plan = planOf(flow);
  if (stage === 4) return { text: plan ? t.statusLive(plan.version) : t.statusActive, tone: 'green' };
  if (stage === 3) return { text: t.statusApproval, tone: 'blue' };
  if (flow.status === 'bozza' && stage < 2) return { text: t.statusDraft, tone: 'neutral' };
  if (plan) return { text: t.statusDay(plan.day, plan.of), tone: 'amber' };
  return { text: t.statusDay(1, 7), tone: 'amber' };
}

const caseTitle = (id: string) => caseSeed(id)?.title ?? id;

/** What the people decided, in a line. */
function peopleLine(caseId: string): string {
  const c = caseSeed(caseId);
  if (!c) return '';
  const e = expectedOf(c);
  return [e.kind, e.office, e.deadline].filter(Boolean).join(' · ');
}

/** What the flow gave: the same line, with the field it read differently. */
function flowLine(o: CaseOutcome): string {
  const c = caseSeed(o.caseId);
  if (!c) return '';
  const e = expectedOf(c);
  const v = { ...e, ...(o.field && o.actual ? { [o.field]: o.actual } : {}) };
  return [v.kind, v.office, v.deadline].filter(Boolean).join(' · ');
}

function addRule(rules: FixedRule[], rule: FixedRule): FixedRule[] {
  return rules.some((r) => r.flow === rule.flow && r.kind === rule.kind) ? rules : [...rules, rule];
}

export function flowTestScreen(p: Params, ctx: ScreenCtx): ReactNode {
  const flow = flowSeed(p.flow);
  const [tests, setTests] = ctx.slice<TestsSlice>('tests', TESTS_INITIAL);
  const [filter, setFilter] = ctx.ui<CaseFilter>(`team.test.${p.flow}.filter`, 'all');
  const [runSel, setRunSel] = ctx.ui<string>(`team.test.${p.flow}.run`, '');
  if (!flow) return notFound(ctx);

  const t = ctx.copy.team.test;
  const cases = flowCases(flow.id);
  const jobId = `test:${flow.id}`;
  const job = ctx.job(jobId);
  const runs = tests.runs.filter((r) => r.target === flow.id);
  const latest = runs[0];
  const stage = stageOf(flow, tests);
  const version = testedVersion(flow);
  const plan = planOf(flow);

  /* The outcomes on show: the run picked in the history, or the latest. */
  const picked: TestRun | undefined = runSel === NIGHT
    ? { id: NIGHT, target: flow.id, kind: 'flow', version, at: ctx.now, by: 'night', outcomes: simulate(flow, []) }
    : runs.find((r) => r.id === runSel);
  const latestOutcomes = outcomesOf(flow, tests);
  const shownOutcomes = picked ? picked.outcomes : latestOutcomes;
  const ev = evaluate(flow, tests, latestOutcomes);

  /* Rows. */
  const outcomeKind = (o: CaseOutcome): CaseOutcomeKind => {
    if (o.pass) return 'pass';
    if (isSettled(o, flow, tests)) return 'resolved';
    return o.rounds && new Set(o.rounds).size > 1 ? 'unstable' : 'fail';
  };
  const sorted = [...shownOutcomes].sort((a, b) => Number(a.pass) - Number(b.pass));
  const counts: Record<CaseFilter, number> = {
    all: sorted.length, fail: sorted.filter((o) => !o.pass).length, pass: sorted.filter((o) => o.pass).length,
  };
  const visible = sorted.filter((o) => (filter === 'all' ? true : filter === 'fail' ? !o.pass : o.pass));
  const caseRows: TestCaseRowModel[] = visible.map((o) => ({
    id: o.caseId,
    title: caseTitle(o.caseId),
    ref: o.caseId,
    people: peopleLine(o.caseId),
    flow: flowLine(o),
    differs: !o.pass,
    outcome: outcomeKind(o),
    onOpen: () => ctx.go(P.record(o.caseId)),
  }));

  const decideItems = (): MenuItemModel[] => {
    const denied = ctx.deniedTitle('run:tests');
    const off = !ctx.can('run:tests');
    return [
      { id: 'flow', label: t.diff.decideItems.flow, disabled: off, title: denied },
      { id: 'person', label: t.diff.decideItems.person, disabled: off || !ctx.can('edit:structure'), title: denied ?? ctx.deniedTitle('edit:structure') },
      { id: 'rule', label: t.diff.decideItems.rule, disabled: !ctx.can('edit:structure'), title: ctx.deniedTitle('edit:structure') },
      { id: 'open', label: t.diff.decideItems.open },
    ];
  };
  const diffRows: DiffRowModel[] = sorted.filter((o) => !o.pass).map((o) => {
    const settledBy = tests.decisions[o.caseId];
    const kind = caseSeed(o.caseId)?.kind;
    const ruleCovers = kind !== undefined && tests.rules.some((r) => r.flow === flow.id && r.kind === kind);
    const right = settledBy === 'flow'
      ? { tone: 'green' as Tone, text: t.diff.right.flowRight }
      : settledBy === 'person'
        ? { tone: 'green' as Tone, text: t.diff.right.personRight }
        : ruleCovers
          ? { tone: 'green' as Tone, text: t.diff.right.ruleAdded }
          : o.rounds && new Set(o.rounds).size > 1
            ? { tone: 'red' as Tone, text: t.diff.right.unstable }
            : { tone: 'amber' as Tone, text: t.diff.right.pending };
    return {
      id: o.caseId,
      title: caseTitle(o.caseId),
      ref: o.caseId,
      flow: flowLine(o),
      rounds: o.rounds ? t.diff.rounds(o.rounds.join(', ')) : undefined,
      people: peopleLine(o.caseId),
      right,
      items: decideItems(),
      onOpen: () => ctx.go(P.record(o.caseId)),
    };
  });

  const nightRow: HistoryRowModel = {
    id: NIGHT,
    title: `${t.history.night} · ${t.history.version(version)}`,
    detail: `${whenLabel(ctx.copy.team, `${ctx.now.slice(0, 10)}T02:30:00+01:00`, ctx.now)}`,
    ok: simulate(flow, []).every((o) => o.pass),
    selected: runSel === NIGHT || (runSel === '' && !latest),
    onSelect: () => setRunSel(NIGHT),
  };
  const history: HistoryRowModel[] = [
    ...runs.map((r) => ({
      id: r.id,
      title: `${t.history.version(r.version)} · ${t.history.row(r.outcomes.filter((o) => o.pass).length, r.outcomes.length)}`,
      detail: `${personName(r.by)} · ${agoLabel(ctx.copy.team, r.at, ctx.now)}`,
      ok: r.outcomes.every((o) => o.pass),
      selected: runSel === r.id || (runSel === '' && r.id === latest?.id),
      onSelect: () => setRunSel(r.id),
    })),
    nightRow,
  ];

  /* The unstable case the aside talks about. */
  const firstUnsettled = ev.unsettled[0] ?? sorted.find((o) => !o.pass);
  const unstableCase = firstUnsettled ? caseSeed(firstUnsettled.caseId) : undefined;
  const unstableRuled = unstableCase ? tests.rules.some((r) => r.flow === flow.id && r.kind === unstableCase.kind) : false;
  const hardCount = cases.filter(isHard).length;

  /* Where the version stands. */
  const missingLabels = ev.criteria.filter((c) => c.state !== 'ok').map((c) => t.criteria.rows[c.id].label.toLowerCase());
  const requestedBy = tests.requestedBy[flow.id];

  /* Actions. */
  const runNow = () => {
    if (cases.length === 0) {
      ctx.toast({ tone: 'info', title: t.job.noCases, body: t.cases.emptyBody });
      return;
    }
    const outcomes = simulate(flow, tests.rules);
    ctx.log(t.log.started(flow.name, version), 'test', P.flowTest(flow.id));
    ctx.startJob({
      id: jobId,
      title: t.job.title(flow.name),
      steps: cases.map((c) => ({ label: t.job.step(c.title), ms: 420 })),
      onDone: () => {
        const passed = outcomes.filter((o) => o.pass).length;
        const run: Omit<TestRun, 'id'> = { target: flow.id, kind: 'flow', version, at: ctx.now, by: ctx.persona.id, outcomes };
        setTests((prev) => ({ ...prev, runs: [{ ...run, id: `run-${prev.runs.length + 1}` }, ...prev.runs] }));
        setRunSel('');
        setFilter('all');
        ctx.log(t.log.finished(flow.name, passed, outcomes.length), 'test', P.flowTest(flow.id));
        ctx.toast({
          tone: passed === outcomes.length ? 'ok' : 'warn',
          title: t.job.toastTitle(flow.name),
          body: t.job.toastBody(passed, outcomes.length),
          action: { label: t.job.openResults, path: P.flowTest(flow.id) },
        });
      },
    });
  };

  const addRuleFor = (caseId: string): boolean => {
    const c = caseSeed(caseId);
    if (!c) return false;
    const rule: FixedRule = { flow: flow.id, kind: c.kind, office: c.office };
    setTests((prev) => ({ ...prev, rules: addRule(prev.rules, rule) }));
    ctx.log(t.log.rule(flow.name, t.gate.rule(CASE_KIND_LABEL[c.kind], OFFICE_LABEL[c.office])), 'structure', P.flowTest(flow.id));
    return true;
  };

  const actions: FlowTestActions = {
    onViewChange: (v) => ctx.go(v === 'steps' ? P.flow(flow.id) : v === 'runs' ? P.flowRuns(flow.id) : v === 'versions' ? P.flowVersions(flow.id) : P.flowTest(flow.id)),
    onRun: job?.status === 'running' ? false : ctx.allow('run:tests', runNow),
    onFilter: setFilter,
    onBackToLast: () => setRunSel(''),
    onAddRule: ctx.allow('edit:structure', () => {
      if (firstUnsettled && addRuleFor(firstUnsettled.caseId)) ctx.toast({ tone: 'ok', title: t.gate.ruleToast });
    }),
    onOpenUnstable: unstableCase ? () => ctx.go(P.record(unstableCase.id)) : undefined,
    onDiffItem: (id, item) => {
      if (item === 'open') {
        ctx.go(P.record(id));
        return;
      }
      if (item === 'flow') {
        setTests((prev) => ({ ...prev, decisions: { ...prev.decisions, [id]: 'flow' } }));
        ctx.log(t.log.decided(caseTitle(id), t.log.sideFlow), 'test', P.flowTest(flow.id));
      } else if (item === 'person') {
        setTests((prev) => ({ ...prev, decisions: { ...prev.decisions, [id]: 'person' } }));
        addRuleFor(id);
        ctx.log(t.log.decided(caseTitle(id), t.log.sidePerson), 'test', P.flowTest(flow.id));
      } else {
        addRuleFor(id);
      }
      ctx.toast({ tone: 'ok', title: item === 'rule' ? t.gate.ruleToast : t.gate.decidedToast });
    },
    onGate: ctx.allow(stage === 3 ? 'approve' : 'run:tests', () => {
      if (stage === 3) {
        ctx.confirm({
          title: t.gate.approveTitle,
          body: t.gate.approveBody(flow.name, version, Math.max(0, (plan?.of ?? 7) - (plan?.day ?? 7))),
          confirmLabel: t.gate.approveConfirm,
          onConfirm: () => {
            setTests((prev) => ({ ...prev, stages: { ...prev.stages, [flow.id]: 'attivo' as Stage } })); // allow-italian: state value compared by value, not shown
            ctx.log(t.log.approved(flow.name, version), 'test', P.flowTest(flow.id));
            ctx.toast({ tone: 'ok', title: t.gate.approvedToast(flow.name, version), action: { label: ctx.copy.flows.views.versions, path: P.flowVersions(flow.id) } });
          },
        });
        return;
      }
      if (stage < 2) {
        ctx.toast({ tone: 'warn', title: t.gate.notRun });
        return;
      }
      if (!ev.ready) {
        ctx.toast({ tone: 'warn', title: t.gate.missing(missingLabels.join(', ')) });
        return;
      }
      setTests((prev) => ({ ...prev, stages: { ...prev.stages, [flow.id]: 'approvazione' as Stage }, requestedBy: { ...prev.requestedBy, [flow.id]: ctx.persona.id } }));
      ctx.log(t.log.requested(flow.name, version), 'test', P.flowTest(flow.id));
      ctx.notify({ title: t.gate.notifyRequestTitle(flow.name, version), body: t.gate.notifyRequestBody, path: P.flowTest(flow.id), tone: 'info', to: ['direzione'] });
      ctx.toast({ tone: 'ok', title: t.gate.requestedToast(flow.name, version) });
    }),
  };

  const jobModel: JobCardModel | undefined = job && job.status !== 'done'
    ? {
      title: t.job.title(flow.name),
      status: job.status,
      progress: job.progress,
      current: job.current,
      detail: t.job.detail(job.done.length, cases.length),
      done: job.done,
      failedTitle: t.job.failedTitle,
      failedBody: t.job.failedBody,
      retryLabel: t.job.retry,
      onRetry: ctx.allow('run:tests', runNow),
    }
    : undefined;

  const model: FlowTestModel = {
    crumbs: [{ label: ctx.copy.flows.root }, { label: flow.name }, { label: t.crumbTitle(version) }],
    status: statusOf(flow, stage, ctx),
    stage,
    criteria: {
      rows: ev.criteria.map((c) => {
        const r = t.criteria.rows[c.id];
        const tone: Tone = c.state === 'ok' ? 'green' : c.state === 'near' ? 'amber' : c.state === 'bad' ? 'red' : 'neutral';
        const requiredText = c.id === 'tried' ? t.criteria.atLeast(c.required)
          : c.id === 'agree' ? t.criteria.atLeast(`${c.required}%`)
            : c.id === 'stable' ? `${c.required}%`
              : c.id === 'hard' ? t.criteria.outOf(Number(c.required), Number(c.required))
                : c.id === 'slow' ? t.criteria.under(`${c.required} s`)
                  : c.required;
        const nowText = c.id === 'hard' ? t.criteria.outOf(Number(c.now), Number(c.required)) : c.id === 'slow' ? `${c.now} s` : c.now;
        const stateText = c.state === 'ok' ? t.criteria.states.ok
          : c.state === 'todo' ? t.criteria.states.todo
            : c.id === 'stable' ? t.criteria.states.unstable(c.n ?? 0)
              : c.id === 'critical' ? t.criteria.states.errors(c.n ?? 0)
                : c.id === 'hard' || c.id === 'agree' ? t.criteria.states.fails(c.n ?? 0)
                  : c.state === 'near' ? t.criteria.states.near : t.criteria.states.bad;
        return { id: c.id, label: r.label, detail: r.detail || undefined, required: requiredText, now: nowText, tone, icon: c.state, stateText, estimate: c.estimate };
      }),
      agreedWith: CRITERIA_AGREED_WITH[flow.id] ?? DEFAULT_AGREED_WITH,
      estimateNote: t.criteria.estimateNote,
    },
    job: jobModel,
    cases: {
      rows: caseRows,
      filter,
      counts,
      shown: visible.length,
      total: sorted.length,
      older: picked && picked.id !== (latest?.id ?? NIGHT) ? t.cases.viewingOlder(picked.id === NIGHT ? t.history.night : timeOf(picked.at)) : undefined,
      emptyBody: t.cases.emptyBody,
    },
    diffs: { rows: diffRows, total: sorted.length, ran: sorted.length > 0 },
    history,
    aside: {
      fixed: { all: cases.length, corrections: hardCount, written: cases.length - hardCount },
      unstable: unstableCase && firstUnsettled ? { kind: CASE_KIND_LABEL[unstableCase.kind], office: OFFICE_LABEL[unstableCase.office], ruleAdded: unstableRuled } : undefined,
      approver: DEFAULT_APPROVER,
      nightly: cases.length,
    },
    gate: {
      day: ev.day,
      of: ev.of,
      missing: ev.ready ? '' : stage < 2 ? t.gate.notRun : t.gate.missing(missingLabels.join(', ')),
      ready: ev.ready && stage >= 2,
      stage,
      requestedBy: requestedBy ? personName(requestedBy) : undefined,
      liveVersion: version,
    },
  };

  return <FlowTestScreen model={model} actions={actions} copy={ctx.copy} phone={ctx.phone} />;
}

export const FLOW_TEST_SCREEN: ScreenDef = {
  id: 'c01',
  path: '/flussi/:flow/collaudo',
  org: 'nocera',
  nav: 'flows',
  needs: 'view:flows',
  samples: [P.flowTest('pec'), P.flowTest('concessioni'), P.flowTest('fatture'), P.flowTest('accesso')],
  tabKey: (p) => `flow:${p.flow}`,
  tab: (p) => ({ label: flowSeed(p.flow)?.name ?? p.flow, kind: 'flows' }),
  title: (p, ctx) => `${flowSeed(p.flow)?.name ?? p.flow} · ${ctx.copy.flows.views.tests}`,
  render: flowTestScreen,
};
