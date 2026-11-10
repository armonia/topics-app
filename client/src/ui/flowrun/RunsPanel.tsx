import { Bot, Search, Sparkles, Split } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Tone } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { Select, TextField } from '../primitives/Field';
import { Table, type TableColumnModel } from '../primitives/Table';
import { Tabs } from '../primitives/Tabs';
import { Avatar } from '../shell/SidebarRows';
import type { RunActor, RunRowModel, UiRunStatus } from './model';

export type RunFilter = 'all' | 'running' | 'person' | 'error' | 'done';

const STATUS_TONE: Record<UiRunStatus, Tone> = { running: 'blue', person: 'amber', blocked: 'red', error: 'red', done: 'green', archived: 'neutral' };

function Actor({ actor, copy }: { actor: RunActor; copy: UiCopy }) {
  const k = copy.flowRun.runs.actor;
  if (actor.kind === 'person') return <span data-tip={actor.text}><Avatar text={actor.text ?? '?'} color={actor.color ?? '#64748b'} size={22} /></span>;
  if (actor.kind === 'robot') return <Chip tone="green" icon={Bot}>{k.robot}</Chip>;
  if (actor.kind === 'rule') return <Chip tone="blue" icon={Split}>{k.rule}</Chip>;
  return <Chip tone="pink" icon={Sparkles}>{k.ai}</Chip>;
}

export interface RunsView {
  filter: RunFilter;
  counts: Record<RunFilter, number>;
  query: string;
  day: string;
  days: Array<{ value: string; label: string }>;
  rows: RunRowModel[];
  /** Nothing ran at all (a flow that is still a draft). */
  neverRan: boolean;
}

/** The runs of a flow (n10): filter by outcome and day, search, and a row opens the run. */
export function RunsPanel({ copy, view, onFilter, onQuery, onDay, onClear }: {
  copy: UiCopy;
  view: RunsView;
  onFilter: (f: RunFilter) => void;
  onQuery: (q: string) => void;
  onDay: (d: string) => void;
  /** Puts the filter, the search and the day back to their start. */
  onClear: () => void;
}) {
  const c = copy.flowRun.runs;
  const columns: TableColumnModel[] = [
    // Case and step share the free room (both are long text); the short columns stay narrow.
    { id: 'no', label: c.colNo, width: 72 },
    { id: 'title', label: c.colCase },
    { id: 'arrived', label: c.colArrived, width: 84 },
    { id: 'step', label: c.colStep },
    { id: 'by', label: c.colBy, width: 84 },
    { id: 'status', label: c.colStatus, width: 250 },
    { id: 'duration', label: c.colDuration, width: 96, align: 'right' },
  ];
  const rows = view.rows.map((r) => ({
    id: r.id,
    onOpen: r.onOpen,
    cells: {
      no: <span className="text-app-text-tertiary">{r.caseNo}</span>,
      title: <span className="font-semibold">{r.title}</span>,
      arrived: r.arrived,
      step: r.step,
      by: <Actor actor={r.actor} copy={copy} />,
      status: <Chip tone={STATUS_TONE[r.status]}>{r.statusText}</Chip>,
      duration: <span className={r.live ? 'italic' : undefined}>{r.duration}</span>,
    },
  }));
  const filters: Array<{ value: RunFilter; label: string }> = [
    { value: 'all', label: c.filters.all },
    { value: 'running', label: c.filters.running },
    { value: 'person', label: c.filters.person },
    { value: 'error', label: c.filters.error },
    { value: 'done', label: c.filters.done },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          ariaLabel={c.filtersLabel}
          value={view.filter}
          onChange={onFilter}
          options={filters.map((f) => ({ ...f, count: view.counts[f.value] }))}
          className="min-w-0 flex-1"
        />
        <TextField size="sm" type="search" icon={Search} value={view.query} onChange={onQuery} placeholder={c.search} className="w-full sm:w-[260px]" />
        <Select size="sm" value={view.day} options={view.days} onChange={onDay} title={c.dayLabel} className="w-[150px]" />
      </div>
      <Table
        ariaLabel={c.tableLabel}
        columns={columns}
        rows={rows}
        empty={view.neverRan ? c.neverRan : (
          <span className="flex flex-col items-center gap-3">
            {view.query ? c.noMatch(view.query) : c.noRuns}
            <Button onClick={onClear}>{c.clear}</Button>
          </span>
        )}
      />
      <p className="text-compact text-app-text-tertiary">{c.footnote}</p>
    </div>
  );
}
