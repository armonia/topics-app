import { Plus, Search, Workflow } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action, StatusModel } from '../types';
import { Blank } from '../primitives/Blank';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Select, TextField } from '../primitives/Field';
import { Table } from '../primitives/Table';
import { PaneHeader } from '../shell/PaneHeader';

export interface OrbitFlowRowModel {
  id: string;
  name: string;
  area: string;
  trigger: string;
  status: StatusModel;
  /** Already formatted: «1.412». */
  perMonth: string;
  /** Items waiting for a person right now, already formatted, or empty. */
  waiting?: string;
  onOpen: () => void;
}

/** The flows of ORBIT as a list (the way into w07): filter by area, search, open one. */
export function OrbitFlowsList({ rows, areas, area, onArea, query, onQuery, onNew, newTitle, onClear, copy }: {
  rows: OrbitFlowRowModel[];
  areas: Array<{ value: string; label: string }>;
  area: string;
  onArea: (a: string) => void;
  query: string;
  onQuery: (q: string) => void;
  onNew: Action;
  newTitle?: string;
  onClear: () => void;
  copy: UiCopy;
}) {
  const s = copy.orgs.orbit;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.flows.root, detail: `${s.orgName} · ${s.flowsCount(rows.length)}` }]}>
        <Button variant="primary" icon={Plus} onClick={onNew} title={newTitle}>{s.newFlow}</Button>
      </PaneHeader>
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border px-4 py-2.5 sm:flex-row sm:items-center">
        <TextField type="search" icon={Search} value={query} onChange={onQuery} placeholder={s.searchFlows} className="sm:w-[280px]" />
        <Select value={area} onChange={onArea} options={areas} title={s.areaFilter} className="sm:w-[200px]" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {rows.length === 0 ? (
          <EmptyState icon={Workflow} title={s.noFlows} action={<Button onClick={onClear}>{s.clearFilters}</Button>}>{s.noFlowsBody}</EmptyState>
        ) : (
          <Table
            ariaLabel={copy.flows.root}
            columns={[
              { id: 'name', label: s.columns.flow, width: 300 },
              { id: 'area', label: s.columns.area, width: 150 },
              { id: 'trigger', label: s.columns.trigger },
              { id: 'status', label: s.columns.status, width: 130 },
              { id: 'perMonth', label: s.columns.perMonth, width: 120, align: 'right' },
              { id: 'waiting', label: s.columns.waiting, width: 130 },
            ]}
            rows={rows.map((r) => ({
              id: r.id,
              onOpen: r.onOpen,
              cells: {
                name: <span className="font-semibold text-app-text">{r.name}</span>,
                area: r.area,
                trigger: r.trigger,
                status: <Chip tone={r.status.tone}>{r.status.text}</Chip>,
                perMonth: <span className="tabular-nums">{r.perMonth}</span>,
                waiting: r.waiting ?? <Blank />,
              },
            }))}
          />
        )}
      </div>
    </div>
  );
}
