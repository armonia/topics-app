import { MigrationScreen, type MigrationView } from '../../../../ui/programs/MigrationScreen';
import type { AdviceRowModel, MigrationModel, PlanBarModel, Verdict } from '../../../../ui/programs/model';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { formatShortDay, isoDay } from '../../../../ui/fixtures/org/clock';
import { MIGRATIONS, PROGRAMS, programSeed, migrationOf } from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { INITIAL_PROGRAMS } from './state';
import { accessLinesOf, clock, flowsUsing, liveComputers, programState, viewOf, withDefaults } from './derive';
import { vaultSlice } from '../../store/vault';
import { runTest, testJobId } from './test';
import { jobView } from './util';

const redoJobId = (id: string) => `programs.redo.${id}`;
const exportJobId = (id: string) => `programs.export.${id}`;

/** p04: how each program could be replaced, and what a migration would take. */
export function MigrationPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.programs;
  const m = c.migration;
  const [slice, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  const [vault] = vaultSlice(ctx);
  const st = viewOf(slice, vault);
  const [sel, setSel] = ctx.ui('programs.migration.program', 'halley');
  const [view, setView] = ctx.ui<MigrationView>('programs.migration.view', 'competitors');
  const [pickedId, setPickedId] = ctx.ui('programs.migration.alt', '');
  const seed = programSeed(sel) ?? PROGRAMS[0];
  const mig = migrationOf(seed.id) ?? MIGRATIONS[0];
  const computers = liveComputers(st);
  const state = programState(seed, st, computers);
  // A finished test whose result the new Halley password cleared no longer describes the program: it is not shown.
  const testJob = jobView(ctx.job(testJobId(seed.id)));
  const shownTest = testJob && (testJob.status === 'running' || st.checks[seed.id]) ? testJob : undefined;
  const researchDay = st.researched[seed.id] ?? mig.research.date;

  const planTotal = mig.advice.plan.reduce((n, p) => n + p.months, 0);
  const bars: PlanBarModel[] = mig.advice.plan.map((p, i) => ({
    id: `p${i}`,
    label: p.label,
    months: p.months,
    start: mig.advice.plan.slice(0, i).reduce((n, q) => n + q.months, 0),
  }));

  const rows: MigrationModel['rows'] = [
    {
      id: 'current', name: seed.name, current: true, holds: m.currentHolds,
      connection: { kind: seed.connection, label: c.common.connection[seed.connection] },
      cloud: m.currentCloud, effort: '-', selected: pickedId === '',
      onSelect: () => setPickedId(''),
    },
    ...mig.alternatives.map((a) => ({
      id: a.id, name: a.name, holds: a.holds, connection: { kind: a.connection, label: a.connectionNote },
      cloud: a.cloud, effort: a.effort, selected: pickedId === a.id, onSelect: () => setPickedId(a.id),
    })),
  ];
  const alt = mig.alternatives.find((a) => a.id === pickedId);

  const pec = FLOWS.find((f) => f.id === 'pec');
  const flows = flowsUsing(seed);
  const matters = [
    ...(seed.id === 'halley' && pec ? [{ label: m.peopleMatter.pecPerMonth, value: c.common.number(pec.perMonth) }] : []),
    { label: m.flowsUse, value: String(flows.length) },
    ...mig.advice.matters,
  ];

  const options = [seed.connection, ...mig.alternatives.map((a) => a.connection)]
    .filter((k, i, all) => all.indexOf(k) === i)
    .map((k) => ({ kind: k, label: c.common.connection[k], about: c.common.connectionAbout[k], current: k === seed.connection }));

  const model: MigrationModel = {
    name: seed.name,
    connection: { kind: seed.connection, label: c.common.connection[seed.connection] },
    holdsLabel: mig.holdsLabel,
    heading: m.heading(seed.name),
    research: m.research(formatShortDay(researchDay), mig.research.sources),
    rows,
    matters,
    advice: {
      verdict: mig.advice.verdict,
      verdictLabel: c.common.verdict[mig.advice.verdict],
      headline: mig.advice.headline,
      reason: mig.advice.reason,
      revisit: mig.advice.revisit,
      plan: mig.advice.plan.map((p) => ({ label: p.label, value: c.common.months(p.months) })),
      planTotal: planTotal > 0 ? m.planTotal(planTotal) : undefined,
      risks: mig.advice.risks,
    },
    bars,
    picked: alt ? {
      name: m.picked(alt.name, seed.name),
      lines: [
        { label: m.pickedLines.connection, value: m.pickedConnection(alt.connectionNote, c.common.connection[seed.connection]) },
        { label: m.pickedLines.cloud, value: alt.cloud },
        { label: m.pickedLines.effort, value: alt.effort },
      ],
    } : undefined,
    now: {
      state: { kind: state.kind, text: c.common.state[state.kind] },
      access: accessLinesOf(seed, st, c),
      options,
    },
  };

  const overview: AdviceRowModel[] = MIGRATIONS.map((x) => {
    const p = programSeed(x.program);
    const months = x.advice.plan.reduce((n, ph) => n + ph.months, 0);
    return {
      id: x.program,
      name: p?.name ?? x.program,
      verdict: x.advice.verdict,
      verdictLabel: c.common.verdict[x.advice.verdict],
      reason: x.advice.headline,
      effort: months > 0 ? m.effortMonths(months) : m.effortNone,
      selected: x.program === seed.id,
      onOpen: () => setSel(x.program),
    };
  });
  const counts = MIGRATIONS.reduce<Record<Verdict, number>>((acc, x) => ({ ...acc, [x.advice.verdict]: acc[x.advice.verdict] + 1 }), { stay: 0, integrate: 0, evaluate: 0, migrate: 0 });

  const exported = st.exported[seed.id];
  const doExport = () => ctx.startJob({
    id: exportJobId(seed.id),
    title: m.exportTitle(seed.name),
    steps: m.exportSteps.map((label, i) => ({ label, ms: 600 + i * 100 })),
    onDone: () => {
      const file = m.exportFile(seed.name);
      update((prev) => {
        const s = withDefaults(prev);
        return { ...s, exported: { ...s.exported, [seed.id]: { at: clock(ctx.now), file } } };
      });
      ctx.toast({ tone: 'ok', title: m.exportToast, body: file });
      ctx.log(m.exportLog(seed.name), 'share', P.migration());
    },
  });
  const redo = () => ctx.startJob({
    id: redoJobId(seed.id),
    title: m.redoTitle,
    steps: m.redoSteps.map((label, i) => ({ label, ms: 700 + i * 150 })),
    onDone: () => {
      update((prev) => {
        const s = withDefaults(prev);
        return { ...s, researched: { ...s.researched, [seed.id]: isoDay(new Date(ctx.now)) } };
      });
      ctx.toast({ tone: 'ok', title: m.redoToast(seed.name) });
      ctx.log(m.redoLog(seed.name), 'knowledge', P.migration());
    },
  });

  const exportJob = jobView(ctx.job(exportJobId(seed.id)));
  return (
    <MigrationScreen
      copy={ctx.copy}
      model={model}
      view={view}
      onView={setView}
      programs={MIGRATIONS.map((x) => ({ value: x.program, label: programSeed(x.program)?.name ?? x.program }))}
      program={seed.id}
      onProgram={(id) => {
        setSel(id);
        setPickedId('');
      }}
      overview={overview}
      counts={counts}
      onRedo={ctx.allow('edit:structure', redo)}
      redoJob={jobView(ctx.job(redoJobId(seed.id)))}
      onExport={ctx.allow('export', doExport)}
      exportJob={exportJob}
      exportReceipt={exported ? m.exportReceipt(exported.file, exported.at) : undefined}
      exportTitle={ctx.deniedTitle('export')}
      onTest={ctx.allow('run:tests', () => runTest(ctx, seed, state.kind === 'to-connect'))}
      testTitle={ctx.deniedTitle('run:tests')}
      testJob={shownTest}
      onOpenProgram={() => ctx.go(P.program(seed.id))}
      backLabel={c.common.programs}
      onBack={() => ctx.go(P.programs())}
      phone={ctx.phone}
    />
  );
}
