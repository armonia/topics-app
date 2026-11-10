import { CircleAlert, ClipboardList, Play, ShieldCheck } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card, StatCard } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Table } from '../primitives/Table';
import { Tabs } from '../primitives/Tabs';
import { PaneHeader } from '../shell/PaneHeader';
import type { TestAllFilter, TestAllModel } from './model';
import { JobCard, StateChip, TitleButton } from './parts';

/**
 * The test of everything (c02): every flow, block of AI, rule, robot, table
 * of fields and procedure that can change a result, with its last test; the
 * ones to look at on top, a button that tests them all in sequence.
 */
export function TestAllScreen({ model, copy, onFilter, onRunAll, phone }: {
  model: TestAllModel;
  copy: UiCopy;
  onFilter: (f: TestAllFilter) => void;
  onRunAll: Action;
  phone?: boolean;
}) {
  const t = copy.team.testAll;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.flows.root }, { label: t.crumb, detail: phone ? undefined : t.detail }]}>
        <Button variant="primary" icon={Play} onClick={onRunAll}>{t.runAll}</Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-3 py-4 md:px-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {model.kpis.map((k) => (
              <StatCard key={k.id} label={k.label} value={k.value} detail={k.detail} tone={k.tone} />
            ))}
          </div>
          {model.job && <JobCard job={model.job} />}
          {model.summary && (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-prose text-emerald-800 dark:text-emerald-300">
              <ShieldCheck size={14} aria-hidden="true" />
              {model.summary}
            </p>
          )}
          {model.attention.length > 0 && (
            <Card title={t.failTitle} icon={CircleAlert} tone="amber">
              <ul className="flex flex-col px-3.5 pb-3 pt-2">
                {model.attention.map((a) => (
                  <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-app-border py-2 last:border-b-0">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-prose font-medium text-app-text">{a.title}</span>
                      <span className="block text-mini text-app-text-secondary">{a.why}</span>
                    </span>
                    <Button size="sm" onClick={a.onOpen}>{a.actionLabel}</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div>
            <Tabs<TestAllFilter>
              ariaLabel={t.filterLabel}
              value={model.filter}
              onChange={onFilter}
              className="mb-2"
              options={[
                { value: 'all', label: t.filters.all, count: model.counts.all },
                { value: 'testing', label: t.filters.testing, count: model.counts.testing },
                { value: 'redo', label: t.filters.redo, count: model.counts.redo },
              ]}
            />
            <Table
              ariaLabel={t.crumb}
              columns={[
                { id: 'what', label: t.columns.what },
                { id: 'kind', label: t.columns.kind, width: 110 },
                { id: 'version', label: t.columns.version, width: 80 },
                { id: 'state', label: t.columns.state, width: 120 },
                { id: 'fixed', label: t.columns.fixed, width: 90, align: 'right' },
                { id: 'stability', label: t.columns.stability, width: 90, align: 'right' },
                { id: 'last', label: t.columns.last, width: 130 },
                { id: 'approvedBy', label: t.columns.approvedBy, width: 120 },
                { id: 'actions', label: t.columns.actions, width: 110 },
              ]}
              rows={model.rows.map((r) => ({
                id: r.id,
                cells: {
                  what: <TitleButton onClick={r.onOpen}>{r.name}</TitleButton>,
                  kind: <Chip tone={r.kindTone}>{r.kind}</Chip>,
                  version: r.version,
                  state: <StateChip tone={r.state.tone} icon={r.state.icon}>{r.state.text}</StateChip>,
                  fixed: r.fixed,
                  stability: r.stability,
                  last: <span className="text-app-text-secondary">{r.last}</span>,
                  approvedBy: <span className="text-app-text-secondary">{r.approvedBy}</span>,
                  actions: <Button size="sm" icon={Play} onClick={r.running ? false : r.onRun}>{r.running ? t.runningRow : t.runOne}</Button>,
                },
              }))}
              empty={
                model.counts.all === 0 ? (
                  <EmptyState icon={ClipboardList} title={t.noneTitle} className="min-h-0 py-4">{t.noneBody}</EmptyState>
                ) : (
                  <EmptyState icon={ClipboardList} title={t.noMatchTitle} className="min-h-0 py-4">{t.noMatchBody}</EmptyState>
                )
              }
            />
            <p className="mt-1.5 text-mini text-app-text-tertiary">{t.statusFootnote}</p>
          </div>
          <Card title={t.rule.title} icon={ShieldCheck} className="bg-app-inset">
            <p className="px-3.5 pb-3 pt-2 text-prose leading-6 text-app-text-secondary">{t.rule.body}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
