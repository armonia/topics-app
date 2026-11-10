import { Bot, OctagonPause, Workflow } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { StatCard } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Table } from '../primitives/Table';
import { FilterBar } from '../filters/FilterBar';
import type { FilterBarModel } from '../filters/model';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { CrumbModel } from '../types';
import { FlowStateChip, StepStrip } from './WorkParts';
import type { FlowRowModel, FlowStatModel } from './work-model';

function CardsCell({ row, copy }: { row: FlowRowModel; copy: UiCopy }) {
  return (
    <span className="flex flex-col items-start gap-1">
      <StepStrip steps={row.steps} label={`${copy.orbitWork.flows.columns.cards}: ${row.open}`} />
      <span className="flex flex-wrap items-center gap-1.5 text-mini text-app-text-tertiary">
        {row.open}
        {row.stuck && <Chip tone="red" icon={OctagonPause}>{row.stuck}</Chip>}
      </span>
    </span>
  );
}

/** A flow as a card, the phone's form of a table row: everything the row says, one under the other. */
function FlowCard({ row, copy }: { row: FlowRowModel; copy: UiCopy }) {
  const f = copy.orbitWork.flows;
  return (
    <li>
      <button type="button" onClick={row.onOpen} className={clsx('block w-full rounded-lg border border-app-border bg-surface px-3.5 py-3 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-prose font-semibold text-app-text">
              {row.icon && <row.icon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
              <span className="min-w-0">{row.name}</span>
            </span>
            {row.outcome && <span className="block text-mini text-app-text-secondary">{row.outcome}</span>}
            <span className="block text-mini text-app-text-tertiary">{row.meta} · {row.area}</span>
          </span>
          <FlowStateChip status={row.status} />
        </span>
        <span className="mt-1.5 block text-prose text-app-text-secondary">{row.trigger}</span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5 text-mini text-app-text-tertiary">
          <span className="tabular-nums">{f.volume(row.perMonth)}</span>
          <span aria-hidden="true">·</span>
          <Bot size={12} aria-hidden="true" className="text-fuchsia-700 dark:text-fuchsia-300" />
          <span>{row.agents}</span>
        </span>
        <span className="mt-2 flex flex-wrap gap-1">{row.programs.map((p) => <Chip key={p}>{p}</Chip>)}</span>
        {/* The table names the strip in its column header; on a card it says it here. */}
        <span className="mt-2.5 block text-mini text-app-text-tertiary">{f.columns.cards}</span>
        <span className="mt-1 block"><CardsCell row={row} copy={copy} /></span>
      </button>
    </li>
  );
}

/**
 * The flows of ORBIT as a list: the one filter bar of every list (team,
 * state, program, agent, with the states as saved filters), and per flow what
 * starts it, the monthly estimate, the programs it uses, how many of its
 * steps an agent does and where its live cards stand, step by step. A row
 * opens the flow. Under 768px each flow is a card instead of a row.
 */
export function OpsFlowsList({ rows, stats, filters, count, copy, phone, crumbs }: {
  rows: FlowRowModel[];
  stats: FlowStatModel[];
  filters: FilterBarModel;
  /** `8 flussi`. (allow-italian: quotes the Italian interface) */
  count: string;
  copy: UiCopy;
  phone?: boolean;
  /** Replaces the built-in crumbs when given. */
  crumbs?: CrumbModel[];
}) {
  const f = copy.orbitWork.flows;
  const c = f.columns;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={crumbs ?? [{ label: f.org }, { label: f.title, detail: count }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 gap-2.5 px-4 pt-4 lg:grid-cols-4">
          {stats.map((s) => <StatCard key={s.id} label={s.label} value={s.value} detail={s.detail} tone={s.tone} />)}
        </div>
        <div className="px-4 pt-3">
          <FilterBar copy={copy} {...filters} placeholder={copy.filters.on.flows} phone={phone} />
        </div>
        <div className="p-4">
          {rows.length === 0 ? (
            <div className="rounded-lg border border-app-border bg-surface">
              <EmptyState icon={Workflow} title={f.empty} action={<Button onClick={filters.onClear}>{f.clear}</Button>} />
            </div>
          ) : phone ? (
            <ul className="space-y-2.5">{rows.map((r) => <FlowCard key={r.id} row={r} copy={copy} />)}</ul>
          ) : (
            <Table
              ariaLabel={f.title}
              /* The monthly estimate sits under what starts the flow, as on the flow page: a column of its own wrapped its header in two lines. */
              columns={[
                { id: 'name', label: c.flow, width: 290 },
                { id: 'status', label: c.status, width: 125 },
                { id: 'trigger', label: c.trigger },
                { id: 'programs', label: c.programs, width: 170 },
                { id: 'agents', label: c.agents, width: 130 },
                { id: 'cards', label: c.cards, width: 250 },
              ]}
              rows={rows.map((r) => ({
                id: r.id,
                onOpen: r.onOpen,
                muted: r.paused,
                cells: {
                  name: (
                    <span className="block">
                      <span className="flex items-center gap-1.5 font-semibold text-app-text">
                        {r.icon && <r.icon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
                        <span className="min-w-0">{r.name}</span>
                      </span>
                      {r.outcome && <span className="block text-compact text-app-text-secondary">{r.outcome}</span>}
                      <span className="block text-compact text-app-text-tertiary">{r.meta} · {r.area}</span>
                    </span>
                  ),
                  status: <FlowStateChip status={r.status} />,
                  trigger: (
                    <span className="block">
                      <span className="block text-app-text-secondary">{r.trigger}</span>
                      <span className="block text-compact tabular-nums text-app-text-tertiary">{f.volume(r.perMonth)}</span>
                    </span>
                  ),
                  programs: <span className="flex flex-wrap gap-1">{r.programs.map((p) => <Chip key={p}>{p}</Chip>)}</span>,
                  agents: (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-app-text-secondary">
                      <Bot size={13} aria-hidden="true" className="shrink-0 text-fuchsia-700 dark:text-fuchsia-300" />
                      {r.agents}
                    </span>
                  ),
                  cards: <CardsCell row={r} copy={copy} />,
                },
              }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
