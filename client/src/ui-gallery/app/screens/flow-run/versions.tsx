/**
 * Versions of a flow and their test on real cases (n09): the list of versions,
 * the comparison with the active one step by step, the test on yesterday's
 * runs with progress and a result per case, and the activation, which needs
 * a passed test and the right to approve.
 */
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { TRIAL_DAY, runsOf } from '../../../../ui/fixtures/flowrun';
import { Chip } from '../../../../ui/primitives/Chip';
import { FlowHeader, StepLayout } from '../../../../ui/flowrun/common';
import type { DiffRow, TestCaseRow, VersionRow } from '../../../../ui/flowrun/model';
import { DiffColumn, DiffDetail, TestCases, TestColumn, VersionList, type TestView } from '../../../../ui/flowrun/VersionsPanel';
import type { StepChange } from '../../../../ui/flowrun/config';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import {
  markerOf, mergeMaps, finishedYesterday, simulate, testSummary, versionChanges, versionsOf, type Outcome, type VersionInfo,
} from './data';
import { VIEWS, toJobView, useFlowSlice, viewPath } from './shared';
import { changeLabel, changeStepId, changeText } from './labels';

const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;

export function VersionsScreen({ ctx, flow }: { ctx: ScreenCtx; flow: FlowSeed }) {
  const copy = ctx.copy;
  const c = copy.flowRun.versions;
  const [st, setSt] = useFlowSlice(ctx, flow);
  const versions = versionsOf(flow, st);
  const [selUi, setSel] = ctx.ui<number | null>(`flowRun.versions.${flow.id}.sel`, null);
  const [rowUi, setRow] = ctx.ui<string | null>(`flowRun.versions.${flow.id}.row`, null);
  const [filter, setFilter] = ctx.ui<'all' | 'changed'>(`flowRun.versions.${flow.id}.filter`, 'all');

  const pending = versions.find((v) => v.n > st.activeN);
  const chosen = versions.find((v) => v.n === selUi) ?? pending ?? versions[0];
  if (!chosen) return null;
  const fromN = chosen.n === st.activeN ? Math.max(0, ...versions.filter((v) => v.n < chosen.n).map((v) => v.n)) : st.activeN;

  /* ---------- the comparison ---------- */
  const changes: StepChange[] = versionChanges(flow, st, chosen);
  const stepChanges = (id: string) => changes.filter((x) => changeStepId(x) === id);
  const addedAfter = (id: string) => changes.filter((x): x is Extract<StepChange, { kind: 'added' }> => x.kind === 'added' && x.after === id);
  const diff: DiffRow[] = [];
  flow.steps.forEach((s, i) => {
    const own = stepChanges(s.id);
    const th = own.find((x): x is Extract<StepChange, { kind: 'threshold' }> => x.kind === 'threshold');
    diff.push({
      id: s.id,
      marker: markerOf(flow, i),
      kind: s.kind,
      program: s.program,
      title: s.label,
      note: own.length ? c.badgeEdited : c.sameAs(fromN),
      change: own.length ? 'changed' : 'same',
      badges: own.length ? [th ? { label: c.badgeThreshold(th.from, th.to), tone: 'amber' } : { label: c.badgeEdited, tone: 'amber' }] : [],
      detail: own.map((x) => ({
        label: changeLabel(copy, x),
        before: x.kind === 'threshold' ? `${x.from}%` : undefined,
        after: x.kind === 'threshold' ? `${x.to}%` : changeText(copy, x),
      })),
    });
    for (const a of addedAfter(s.id)) {
      diff.push({
        id: `add-${s.id}-${a.title}`, marker: `${markerOf(flow, i)}+`, kind: a.stepKind, title: a.title, note: a.note, change: 'added',
        badges: [{ label: c.badgeNew, tone: 'green' }], detail: [{ label: c.changeLabel.added, after: changeText(copy, a) }],
      });
    }
  });
  const firstChanged = diff.find((d) => d.change !== 'same')?.id ?? diff[0]?.id ?? null;
  const rowId = rowUi && diff.some((d) => d.id === rowUi) ? rowUi : firstChanged;
  const diffRows = diff.map((d) => ({ ...d, selected: d.id === rowId, onSelect: () => setRow(d.id) }));
  const addedCount = changes.filter((x) => x.kind === 'added').length;
  const thresholdCount = changes.filter((x) => x.kind === 'threshold').length;
  const otherCount = changes.length - addedCount - thresholdCount;
  const chips = [
    ...(addedCount ? [{ label: c.chipAdded(addedCount), tone: 'green' as const }] : []),
    ...(thresholdCount ? [{ label: c.chipThreshold(thresholdCount), tone: 'amber' as const }] : []),
    ...(otherCount ? [{ label: c.chipEdited(otherCount), tone: 'amber' as const }] : []),
  ];

  /* ---------- the test ---------- */
  const record = st.tests[String(chosen.n)];
  const jobId = `test:${flow.id}:${chosen.n}`;
  const job = toJobView(ctx.job(jobId));
  const runs = runsOf(flow.id);
  const rows: TestCaseRow[] = (record?.rows ?? []).map((r) => {
    const run = runs.find((x) => x.id === r.runId);
    const runCase = run ? caseSeed(run.caseId) : undefined;
    const word = (o: Outcome) => (o === 'person' ? c.outcome.person : o === 'flow' ? c.outcome.flow : c.outcome.auto);
    return {
      id: r.runId,
      label: runCase?.title ?? run?.title ?? r.runId,
      confidence: run?.confidence ?? 0,
      before: word(r.before),
      after: word(r.after),
      change: r.change,
      onOpen: () => ctx.go(runCase ? P.record(runCase.id) : P.flowRun(flow.id, r.runId)),
    };
  });
  const sum = record ? testSummary(record) : { same: 0, better: 0, risky: 0, morePerson: 0, newFlow: 0 };
  const testView: TestView = {
    state: job?.status === 'running' ? 'running' : record ? 'done' : 'none',
    job,
    at: record ? fmtDay(record.at) : '',
    total: record?.total ?? runs.filter(finishedYesterday).length,
    same: sum.same,
    fewer: sum.better,
    newFlow: sum.newFlow,
    worse: sum.risky,
    morePerson: sum.morePerson,
    rows,
    filter,
  };
  const changedRows = rows.filter((r) => r.change !== 'same').slice(0, 8);

  const runTest = (v: VersionInfo) => () => {
    ctx.startJob({
      id: `test:${flow.id}:${v.n}`,
      title: c.testLabel(v.n),
      steps: c.testSteps.map((label, i) => ({ label, ms: 550 + i * 150 })),
      onDone: (ok) => {
        if (!ok) return;
        setSt((s) => ({ ...s, tests: { ...s.tests, [String(v.n)]: simulate(flow, s, v.n, v.overrides, v.added, ctx.now) } }));
        ctx.log(c.logTested(flow.name, v.n), 'test', P.flowVersions(flow.id));
        ctx.toast({ tone: 'ok', title: c.testDone(v.n), body: c.testDoneBody });
      },
    });
  };

  /* ---------- activate, go back, delete ---------- */
  const activate = (v: VersionInfo) => () => {
    const t = st.tests[String(v.n)];
    if (!t) {
      ctx.toast({ tone: 'warn', title: c.testFirst, body: c.testFirstBody });
      return;
    }
    if (testSummary(t).risky > 0) {
      ctx.toast({ tone: 'error', title: c.testRisky, body: c.worse(testSummary(t).risky) });
      return;
    }
    ctx.confirm({
      title: c.confirmActivateTitle(v.n),
      body: c.confirmActivateBody(v.n, st.activeN),
      confirmLabel: c.activate(v.n),
      onConfirm: () => {
        setSt((s) => {
          const activeOv = mergeMaps(s.activeOv, v.overrides);
          return { ...s, activeN: v.n, activeOv, snapshots: { ...s.snapshots, [String(v.n)]: activeOv }, working: v.saved ? {} : s.working };
        });
        ctx.log(c.logActivated(flow.name, v.n), 'structure', P.flowVersions(flow.id));
        ctx.notify({ title: c.notifyActivated(flow.name, v.n), body: c.notifyBody, path: P.flowVersions(flow.id), tone: 'ok' });
        ctx.toast({ tone: 'ok', title: c.activated(v.n), body: c.activatedBody });
      },
    });
  };
  const rollback = (v: VersionInfo) => () => ctx.confirm({
    title: c.confirmRollbackTitle(v.n),
    body: c.confirmRollbackBody(v.n),
    confirmLabel: c.rollback(v.n),
    onConfirm: () => {
      setSt((s) => ({ ...s, activeN: v.n, activeOv: s.snapshots[String(v.n)] ?? {} }));
      ctx.log(c.logRolledBack(flow.name, v.n), 'structure', P.flowVersions(flow.id));
      ctx.notify({ title: c.notifyRolledBack(flow.name, v.n), body: c.notifyBody, path: P.flowVersions(flow.id), tone: 'info' });
      ctx.toast({ tone: 'ok', title: c.rolledBack(v.n) });
    },
  });
  const remove = (v: VersionInfo) => () => ctx.confirm({
    title: c.confirmDeleteTitle(v.n),
    body: c.confirmDeleteBody,
    confirmLabel: c.menuDelete,
    tone: 'danger',
    onConfirm: () => {
      setSt((s) => {
        const tests = { ...s.tests };
        delete tests[String(v.n)];
        return { ...s, saved: s.saved.filter((x) => x.n !== v.n), tests };
      });
      if (chosen.n === v.n) setSel(null);
      ctx.log(c.logDeleted(flow.name, v.n), 'structure', P.flowVersions(flow.id));
      ctx.toast({ tone: 'info', title: c.deleted(v.n) });
    },
  });

  const approveDenied = ctx.deniedTitle('approve');
  const testDenied = ctx.deniedTitle('run:tests');
  const structureDenied = ctx.deniedTitle('edit:structure');
  const menuFor = (v: VersionInfo): VersionRow['menu'] => {
    const items: VersionRow['menu'] = [];
    if (v.n > st.activeN) items.push({ id: 'activate', label: c.menuActivate, disabled: !ctx.can('approve'), title: approveDenied });
    if (v.n < st.activeN) items.push({ id: 'rollback', label: c.menuRollback(v.n), disabled: !ctx.can('approve'), title: approveDenied });
    items.push({ id: 'test', label: c.menuTest, disabled: !ctx.can('run:tests'), title: testDenied });
    if (v.saved && v.n !== st.activeN) items.push({ id: 'delete', label: c.menuDelete, danger: true, disabled: !ctx.can('edit:structure'), title: structureDenied });
    return items;
  };
  const onMenu = (n: number, id: string) => {
    const v = versions.find((x) => x.n === n);
    if (!v) return;
    if (id === 'activate') activate(v)();
    else if (id === 'rollback') rollback(v)();
    else if (id === 'test') runTest(v)();
    else if (id === 'delete') remove(v)();
  };

  const versionRows: VersionRow[] = versions.map((v) => ({
    id: String(v.n), n: v.n, status: v.status, who: v.who, at: fmtDay(v.at), summary: v.summary,
    selected: v.n === chosen.n, onSelect: () => { setSel(v.n); setRow(null); }, menu: menuFor(v),
  }));

  const statusChip = chosen.status === 'testing' && flow.id === 'pec'
    ? <Chip tone="amber">{c.collaudoDay(TRIAL_DAY.day, TRIAL_DAY.of)}</Chip>
    : <Chip tone={chosen.status === 'active' ? 'green' : 'neutral'}>{c.status[chosen.status]}</Chip>;

  const detailRow = diffRows.find((d) => d.selected);
  const previous = Math.max(0, ...versions.filter((v) => v.n < st.activeN).map((v) => v.n)) || st.activeN;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FlowHeader
        copy={copy}
        flowName={flow.name}
        here={c.crumb(chosen.n, fromN)}
        status={statusChip}
        views={VIEWS}
        view="versions"
        onView={(v) => ctx.go(viewPath(flow.id, v))}
        onBack={() => ctx.go(P.flow(flow.id))}
        phone={ctx.phone}
      />
      <StepLayout
        rail={(
          <div className="flex flex-col gap-5">
            <VersionList copy={copy} versions={versionRows} onMenu={onMenu} />
            <DiffColumn copy={copy} chips={chips} diff={diffRows} />
          </div>
        )}
        aside={(
          <TestColumn
            copy={copy}
            test={testView}
            compare={{ from: fromN, to: chosen.n }}
            publish={{ approver: c.approverValue, rollbackTo: chosen.n !== st.activeN ? st.activeN : previous, activeN: st.activeN, testing: chosen.status === 'testing', day: flow.id === 'pec' ? TRIAL_DAY : undefined }}
            onRun={ctx.allow('run:tests', runTest(chosen))}
            runDisabled={testDenied}
            onActivate={chosen.n > st.activeN ? ctx.allow('approve', activate(chosen)) : chosen.n < st.activeN ? ctx.allow('approve', rollback(chosen)) : false}
            activateTitle={approveDenied}
            activateLabel={chosen.n < st.activeN ? c.rollback(chosen.n) : c.activate(chosen.n)}
            activate={chosen.n === st.activeN ? 'active' : 'enabled'}
            changes={changedRows.map((r) => ({
              id: r.id,
              label: `${r.label} · ${r.confidence}%`,
              value: c.toText(r.change, r.before, r.after),
              onOpen: r.onOpen,
            }))}
          />
        )}
        asideWidth={440}
      >
        <div className="flex min-w-0 flex-col gap-4 p-5">
          <DiffDetail copy={copy} row={detailRow} fromN={fromN} toN={chosen.n} />
          {testView.state === 'done' && <TestCases copy={copy} test={testView} onFilter={setFilter} />}
        </div>
      </StepLayout>
    </div>
  );
}
