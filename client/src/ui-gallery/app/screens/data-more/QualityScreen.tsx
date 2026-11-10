/**
 * q01 live: the six dimensions of ISO/IEC 25012 with scores computed from the
 * example rows where a control can run on them, the controls that weigh on
 * the score (each can be switched off), what was found this week, and the
 * items waiting in quarantine. «Check again now» runs the comparison as a
 * simulated job with visible progress.
 */
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { SegmentedControl } from '../../../../components/Shared/Segmented';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { Table } from '../../../../ui/primitives/Table';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { ChecksCard, DimensionsCard, Kpis, OddityCard, QualitySide } from '../../../../ui/quality/QualityParts';
import type { CheckRowModel, DimensionRowModel, OddityRowModel } from '../../../../ui/quality/model';
import type { Tone } from '../../../../ui/types';
import { CHECKS, DIMENSION_IDS, QUALITY_TOTALS, QUARANTINE } from '../../../../ui/fixtures/quality';
import { formatDay, DEMO_TODAY } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { computeQuality, pendingItems, type QuarantineDecisions } from './quality';

type Tab = 'overview' | 'checks' | 'quarantine';

const toneOf = (pct: number | null): Tone => (pct === null ? 'neutral' : pct >= 99 ? 'green' : pct >= 95 ? 'amber' : 'red');

export function QualityScreen({ ctx }: { ctx: ScreenCtx }) {
  const d = ctx.copy.dataMore;
  const t = d.quality;
  const fmt = new Intl.NumberFormat(d.format.locale);
  const [tab, setTab] = ctx.ui<Tab>('dm.q.tab', 'overview');
  const [dimension, setDimension] = ctx.ui<string>('dm.q.dim', '');
  const [off, setOff] = ctx.slice<string[]>('qualityOff', []);
  const [run, setRun] = ctx.slice<{ at: string } | null>('qualityRun', null);
  const [decisions] = ctx.slice<QuarantineDecisions>('quarantine', {});
  const q = computeQuality(ctx.state, off);
  const pending = pendingItems(decisions);
  const canEdit = ctx.can('edit:structure');
  const job = ctx.job('quality-run');
  const running = job?.status === 'running';
  const pct = (n: number | null) => (n === null ? '-' : d.format.percent(n));

  const recheck = () => {
    ctx.startJob({
      id: 'quality-run',
      title: t.job.title,
      steps: [{ label: t.job.topics, ms: 700 }, { label: t.job.halley, ms: 800 }, { label: t.job.prunes, ms: 800 }, { label: t.job.teamsystem, ms: 800 }],
      onDone: () => {
        setRun(() => ({ at: ctx.now }));
        ctx.log(d.log.qualityRun(q.rowsMeasured), 'test', P.quality());
        ctx.toast({ tone: 'ok', title: t.job.done, body: t.job.doneBody(q.rowsMeasured) });
      },
    });
  };

  const dimensions: DimensionRowModel[] = q.dimensions.map((x) => ({
    id: x.id,
    name: t.dimensions[x.id].name,
    means: t.dimensions[x.id].means,
    example: (CHECKS.find((c) => c.dimension === x.id)?.label) ?? '',
    pctText: pct(x.pct),
    tone: toneOf(x.pct),
    on: x.checks.filter((c) => c.on).length,
    total: x.checks.length,
  }));
  const statusOf = (id: string): { text: string; tone: Tone; waiting: boolean } => {
    const seed = QUARANTINE.find((x) => x.id === id);
    const decision = decisions[id];
    if (seed?.settled) return { text: seed.settled.text, tone: 'green', waiting: false };
    if (decision?.status === 'confirmed') return { text: t.status.confirmed, tone: 'green', waiting: false };
    if (decision?.status === 'rejected') return { text: t.status.rejected, tone: 'green', waiting: false };
    if (decision?.status === 'asked') return { text: t.status.asked, tone: 'amber', waiting: true };
    return { text: t.status.quarantine, tone: 'amber', waiting: true };
  };
  const oddities: OddityRowModel[] = QUARANTINE.map((x) => {
    const s = statusOf(x.id);
    return { id: x.id, title: x.title, where: x.where, summary: x.summary, statusText: s.text, statusTone: s.tone, waiting: s.waiting };
  });
  const checks: CheckRowModel[] = q.results
    .filter((r) => !dimension || r.check.dimension === dimension)
    .map((r) => ({
      id: r.check.id,
      label: r.check.label,
      where: r.check.where,
      dimension: t.dimensions[r.check.dimension].name,
      scope: t.scopes[r.check.scope],
      pctText: pct(r.pct),
      tone: toneOf(r.pct),
      basis: r.computed ? t.basisRows(r.total ?? 0) : t.basisExample,
      on: r.on,
      failing: r.failing.length,
    }));
  const toggleCheck = (id: string, on: boolean) => {
    const label = CHECKS.find((c) => c.id === id)?.label ?? id;
    setOff((prev) => (on ? prev.filter((x) => x !== id) : [...prev, id]));
    ctx.log(d.log.checkToggled(label, on), 'structure', P.quality());
    ctx.toast({ tone: on ? 'ok' : 'warn', title: on ? t.toast.checkOn : t.toast.checkOff, body: label });
  };

  const blocked = QUALITY_TOTALS.autoCorrected + QUARANTINE.filter((x) => !x.settled).length;
  const kpis = [
    { id: 'rows', label: t.kpi.rows, value: fmt.format(QUALITY_TOTALS.rowsPerDay), detail: t.kpi.rowsDetail },
    { id: 'blocked', label: t.kpi.blocked, value: String(blocked), detail: t.kpi.blockedDetail(QUALITY_TOTALS.autoCorrected, pending.length), tone: 'amber' as const },
    { id: 'errors', label: t.kpi.errors, value: '0', detail: t.kpi.errorsDetail, tone: 'green' as const },
    { id: 'score', label: t.kpi.score, value: pct(q.overall), detail: t.kpi.scoreDetail },
  ];
  const counts = (['field', 'tables', 'programs', 'outliers'] as const).map((s) => ({ label: t.scopes[s], value: String(QUALITY_TOTALS.checks[s]) }));
  const tabLabel = (v: Tab) => (v === 'quarantine' ? t.tabs.quarantine(pending.length) : t.tabs[v]);

  const main = tab === 'checks' ? (
    <ChecksCard
      rows={checks}
      copy={ctx.copy}
      dimension={dimension}
      dimensionOptions={[{ value: '', label: t.allDimensions }, ...DIMENSION_IDS.map((x) => ({ value: x, label: t.dimensions[x].name }))]}
      onDimension={setDimension}
      onToggle={toggleCheck}
      canEdit={canEdit}
      deniedTitle={ctx.deniedTitle('edit:structure')}
      empty={t.noChecks}
    />
  ) : tab === 'quarantine' ? (
    <Table
      ariaLabel={t.tabs.quarantine(pending.length)}
      columns={[
        { id: 'title', label: t.columns.what, width: 250 },
        { id: 'where', label: t.columns.where, width: 130 },
        { id: 'since', label: t.columns.since, width: 120 },
        { id: 'summary', label: t.columns.happened, width: 340 },
        { id: 'status', label: t.columns.status, width: 150 },
      ]}
      rows={pending.map((x) => {
        const s = statusOf(x.id);
        return {
          id: x.id,
          onOpen: () => ctx.go(P.qualityItem(x.id)),
          cells: {
            title: <span className="font-semibold">{x.title}</span>,
            where: x.where,
            since: formatDay(x.at.slice(0, 10)),
            summary: <span className="block whitespace-normal leading-5">{x.summary}</span>,
            status: <Chip tone={s.tone}>{s.text}</Chip>,
          },
        };
      })}
      empty={<EmptyState icon={ShieldCheck} title={t.noQuarantine} className="min-h-0 py-6">{t.noQuarantineBody}</EmptyState>}
    />
  ) : (
    <div className="space-y-4">
      <Kpis kpis={kpis} />
      <DimensionsCard rows={dimensions} copy={ctx.copy} onOpen={(id) => { setDimension(id); setTab('checks'); }} />
      <OddityCard rows={oddities} copy={ctx.copy} onOpen={(id) => ctx.go(P.qualityItem(id))} />
    </div>
  );

  const controls = (
    <>
      <SegmentedControl ariaLabel={t.tabsLabel} value={tab} onChange={setTab} options={(['overview', 'checks', 'quarantine'] as const).map((v) => ({ value: v, label: tabLabel(v) }))} />
      <Button icon={RefreshCw} onClick={running ? false : recheck}>{t.recheck}</Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: ctx.copy.data.root }, { label: t.crumb }]} status={ctx.phone ? undefined : <Chip tone="green">{t.continuous}</Chip>}>{!ctx.phone && controls}</PaneHeader>
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">{controls}</div>}
      <div className={ctx.phone ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : 'flex min-h-0 flex-1'}>
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 max-sm:px-3">
          {running && job && <ProgressBar value={job.progress} label={job.current} detail={job.title} />}
          {main}
        </div>
        <QualitySide copy={ctx.copy} counts={counts} lastRun={run ? t.lastRunNow(formatDay(DEMO_TODAY)) : t.lastNight} phone={ctx.phone} />
      </div>
    </div>
  );
}
