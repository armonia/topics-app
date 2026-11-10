import { Check, FileDown, FlaskConical, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { TONE_CHIP } from '../tone';
import { Button } from '../primitives/Button';
import { Card, StatCard } from '../primitives/Card';
import { EmptyState } from '../primitives/EmptyState';
import { Select } from '../primitives/Field';
import { KeyValue, PanelSection, SidePanel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import type { AdviceRowModel, JobViewModel, MigrationModel, Verdict } from './model';
import { STATE_TONE, VERDICT_TONE } from './model';
import { ConnectionChip, DataGrid, JobProgress, StatePill } from './Shared';

export type MigrationView = 'overview' | 'connection' | 'competitors' | 'migration';

const VERDICTS: Verdict[] = ['stay', 'integrate', 'evaluate', 'migrate'];

function Advice({ model, copy, onExport, exportJob, exportReceipt, exportTitle, phone }: {
  phone?: boolean;
  exportReceipt?: string;
  model: MigrationModel;
  copy: UiCopy;
  onExport: Action;
  exportJob?: JobViewModel;
  exportTitle?: string;
}) {
  const m = copy.programs.migration;
  const a = model.advice;
  const busy = exportJob?.status === 'running';
  return (
    <SidePanel
      width={360}
      className={phone ? '!h-auto !w-full !border-l-0' : undefined}
      footer={
        <div className="space-y-2.5">
          {exportJob && <JobProgress job={exportJob} copy={copy} />}
          {exportReceipt && !busy && <p className="flex items-start gap-1.5 text-compact text-emerald-700 dark:text-emerald-400"><Check size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{exportReceipt}</p>}
          {!busy && <Button icon={FileDown} onClick={onExport} title={exportTitle}>{m.export}</Button>}
        </div>
      }
    >
      <div className="border-b border-app-border px-4 pb-4 pt-4">
        <span className={clsx('mb-2 inline-flex h-5 items-center rounded px-1.5 text-mini', TONE_CHIP[VERDICT_TONE[a.verdict]])}>{m.advice}</span>
        <h3 className="text-body-lg font-semibold leading-5 text-app-text">{a.headline}</h3>
        <p className="mt-1 text-prose leading-5 text-app-text-secondary">{a.reason}</p>
      </div>
      {a.revisit.length > 0 && (
        <PanelSection label={m.revisit}>
          {a.revisit.map((r) => (
            <div key={r.when} className="flex min-h-7 items-start gap-3 py-1 text-prose leading-5">
              <span className="min-w-0 flex-1 text-app-text">{r.when}</span>
              <span className="max-w-[45%] shrink-0 text-right font-semibold text-app-text">{r.then}</span>
            </div>
          ))}
        </PanelSection>
      )}
      <PanelSection label={m.plan}>
        {a.plan.length === 0 && <p className="text-prose text-app-text-tertiary">{m.planNone}</p>}
        {a.plan.map((p, i) => <KeyValue key={p.label} label={`${i + 1} · ${p.label}`} value={<span className="font-semibold">{p.value}</span>} />)}
        {a.planTotal && <p className="mt-1 text-compact text-app-text-tertiary">{a.planTotal}</p>}
      </PanelSection>
      <PanelSection label={m.risks} className="border-b-0">
        <p className="text-prose leading-6 text-app-text-secondary">{a.risks || m.risksNone}</p>
      </PanelSection>
    </SidePanel>
  );
}

/**
 * Competitors and migration advice (p04). One program at a time (chosen at
 * the top), four views of it: an overview of the advice for every program,
 * how it connects today and how else it could, who could replace it, and
 * what a migration would take. The advice panel on the right stays whatever
 * the view. Every figure is an estimate and says so.
 */
export function MigrationScreen({
  copy, model, view, onView, programs, program, onProgram, overview, counts, onRedo, redoJob, onExport, exportJob, exportReceipt, exportTitle,
  onTest, testTitle, testJob, onOpenProgram, backLabel, onBack, phone,
}: {
  copy: UiCopy;
  model: MigrationModel;
  view: MigrationView;
  onView: (v: MigrationView) => void;
  programs: Array<{ value: string; label: string }>;
  program: string;
  onProgram: (id: string) => void;
  overview: AdviceRowModel[];
  counts: Record<Verdict, number>;
  onRedo: Action;
  redoJob?: JobViewModel;
  onExport: Action;
  exportJob?: JobViewModel;
  exportReceipt?: string;
  exportTitle?: string;
  onTest: Action;
  testTitle?: string;
  testJob?: JobViewModel;
  onOpenProgram: Action;
  backLabel: string;
  onBack: () => void;
  phone?: boolean;
}) {
  const m = copy.programs.migration;
  const redoing = redoJob?.status === 'running';
  const totalMonths = Math.max(1, ...model.bars.map((b) => b.start + b.months));
  const body = (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select label={m.programLabel} value={program} options={programs} onChange={onProgram} className="w-[220px]" />
        <div className="min-w-0 flex-1" />
        {view !== 'overview' && !redoing && <Button icon={RefreshCw} onClick={onRedo}>{m.redo}</Button>}
      </div>
      {redoJob && <JobProgress job={redoJob} copy={copy} className="mb-4" />}

      {view === 'overview' && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {VERDICTS.map((v) => <StatCard key={v} label={copy.programs.common.verdict[v]} value={counts[v]} tone={VERDICT_TONE[v]} detail={copy.programs.common.verdictAbout[v]} />)}
          </div>
          <h2 className="mb-2 text-body-lg font-semibold text-app-text">{m.overviewTitle}</h2>
          <p className="mb-3 text-prose text-app-text-secondary">{m.overviewHint}</p>
          <DataGrid
            ariaLabel={m.overviewTitle}
            columns={[
              { id: 'program', label: m.overviewColumns.program, width: 160 },
              { id: 'advice', label: m.overviewColumns.advice, width: 130 },
              { id: 'why', label: m.overviewColumns.why },
              { id: 'effort', label: m.overviewColumns.effort, width: 170 },
            ]}
            rows={overview.map((r) => ({
              id: r.id,
              selected: r.selected,
              onOpen: r.onOpen || undefined,
              cells: {
                program: <span className="font-semibold">{r.name}</span>,
                advice: <span className={clsx('inline-flex h-5 items-center rounded px-1.5 text-mini', TONE_CHIP[VERDICT_TONE[r.verdict]])}>{r.verdictLabel}</span>,
                why: <span className="line-clamp-2 whitespace-normal text-app-text-secondary">{r.reason}</span>,
                effort: <span className="text-app-text-secondary">{r.effort}</span>,
              },
            }))}
          />
          <div className="mt-3"><Button onClick={onOpenProgram}>{m.openProgram}</Button></div>
        </>
      )}

      {view === 'connection' && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={m.connectionNow}>
            <div className="flex flex-wrap items-center gap-2">
              <ConnectionChip kind={model.connection.kind} label={model.connection.label} />
              <StatePill tone={STATE_TONE[model.now.state.kind]}>{model.now.state.text}</StatePill>
            </div>
            <div className="mt-3 space-y-0.5">
              {model.now.access.map((r) => <KeyValue key={r.label} label={r.label} value={r.value} />)}
            </div>
            <div className="mt-3">
              {testJob?.status === 'running' ? <JobProgress job={testJob} copy={copy} /> : <Button icon={FlaskConical} onClick={onTest} title={testTitle}>{copy.programs.list.detail.test}</Button>}
              {testJob && testJob.status !== 'running' && <JobProgress job={testJob} copy={copy} className="mt-2" />}
            </div>
          </Card>
          <Card title={m.connectionCould}>
            <p className="mb-2 text-prose text-app-text-secondary">{m.connectionCouldBody}</p>
            <ul className="space-y-2">
              {model.now.options.map((o) => (
                <li key={o.kind} className="flex items-start gap-2">
                  <ConnectionChip kind={o.kind} label={o.label} className="mt-0.5" />
                  <span className="min-w-0 flex-1 text-prose leading-5 text-app-text-secondary">{o.about}</span>
                  {o.current && <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-mini', TONE_CHIP.green)}><Check size={11} aria-hidden="true" />{m.matchesNow}</span>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {view === 'competitors' && (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
            <h2 className="text-[17px] font-semibold text-app-text">{model.heading}</h2>
            <span className="text-prose text-app-text-tertiary">{model.research}</span>
          </div>
          {model.rows.length <= 1 ? (
            <div className="rounded-lg border border-app-border bg-surface">
              <EmptyState title={m.noAlternatives} className="min-h-[160px]">{m.noAlternativesBody}</EmptyState>
            </div>
          ) : (
            <DataGrid
              ariaLabel={model.heading}
              columns={[
                { id: 'program', label: m.columns.program, width: 200 },
                { id: 'holds', label: model.holdsLabel, width: 150 },
                { id: 'connection', label: m.columns.connection, width: 190 },
                { id: 'cloud', label: m.columns.cloud, width: 200 },
                { id: 'effort', label: m.columns.migration, width: 170 },
              ]}
              rows={model.rows.map((r) => ({
                id: r.id,
                selected: r.selected,
                onOpen: r.onSelect || undefined,
                cells: {
                  program: <span className="font-semibold">{r.name}{r.current && <span className="ml-2 text-mini font-normal text-emerald-700 dark:text-emerald-400">{m.current}</span>}</span>,
                  holds: r.holds,
                  connection: <ConnectionChip kind={r.connection.kind} label={r.connection.label} />,
                  cloud: r.cloud,
                  effort: r.effort,
                },
              }))}
            />
          )}
          {model.picked && (
            <div className="mt-3 rounded-lg border border-app-border bg-app-inset px-4 py-3">
              <p className="mb-1 text-prose font-semibold text-app-text">{model.picked.name}</p>
              {model.picked.lines.map((l) => <KeyValue key={l.label} label={l.label} value={l.value} />)}
            </div>
          )}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card title={m.matters}>
              {model.matters.length === 0 && <p>{m.effortNone}</p>}
              {model.matters.map((r) => <KeyValue key={r.label} label={r.label} value={<span className="font-semibold">{r.value}</span>} />)}
            </Card>
            <Card title={m.signals}>{m.signalsBody}</Card>
          </div>
        </>
      )}

      {view === 'migration' && (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
            <h2 className="text-[17px] font-semibold text-app-text">{model.name}</h2>
            <span className="text-prose text-app-text-tertiary">{m.estimateNote}</span>
          </div>
          {model.bars.length === 0 ? (
            <div className="rounded-lg border border-app-border bg-surface"><EmptyState title={m.planNone} className="min-h-[160px]">{m.changeEffort}</EmptyState></div>
          ) : (
            <div className="rounded-lg border border-app-border bg-surface p-4">
              <ol className="space-y-3">
                {model.bars.map((b, i) => (
                  <li key={b.id}>
                    <div className="mb-1 flex items-baseline gap-2 text-prose">
                      <span className="font-medium text-app-text">{i + 1} · {b.label}</span>
                      <span className="ml-auto tabular-nums text-app-text-secondary">{copy.programs.common.months(b.months)}</span>
                    </div>
                    <div className="relative h-2 rounded-full bg-black/[0.06] dark:bg-white/[0.08]" aria-hidden="true">
                      <span className="absolute top-0 h-2 rounded-full bg-primary" style={{ left: `${(b.start / totalMonths) * 100}%`, width: `${(b.months / totalMonths) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ol>
              {model.advice.planTotal && <p className="mt-3 text-compact text-app-text-tertiary">{model.advice.planTotal}</p>}
            </div>
          )}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card title={m.risks}>{model.advice.risks || m.risksNone}</Card>
            <Card title={m.revisit}>
              {model.advice.revisit.map((r) => <KeyValue key={r.when} label={r.when} value={<span className="font-semibold">{r.then}</span>} />)}
            </Card>
          </div>
        </>
      )}
    </div>
  );
  const side = <Advice model={model} copy={copy} onExport={onExport} exportJob={exportJob} exportReceipt={exportReceipt} exportTitle={exportTitle} phone={phone} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        leading={<BackButton label={backLabel} onClick={onBack} copy={copy} />}
        crumbs={[{ label: model.name }]}
        status={<ConnectionChip kind={model.connection.kind} label={model.connection.label} />}
      >
        {!phone && (
          <SegmentedControl
            value={view}
            onChange={onView}
            ariaLabel={m.viewsLabel}
            options={(['overview', 'connection', 'competitors', 'migration'] as const).map((v) => ({ value: v, label: m.views[v] }))}
          />
        )}
      </PaneHeader>
      {phone && (
        <div className="shrink-0 overflow-x-auto border-b border-app-border px-3 py-2">
          <SegmentedControl
            value={view}
            onChange={onView}
            ariaLabel={m.viewsLabel}
            options={(['overview', 'connection', 'competitors', 'migration'] as const).map((v) => ({ value: v, label: m.views[v] }))}
          />
        </div>
      )}
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {body}
          <div className="border-t border-app-border">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {body}
          {side}
        </div>
      )}
    </div>
  );
}
