import type { UiCopy } from '../copy/types';
import type { Action, ItemLinks } from '../types';
import { Blank } from '../primitives/Blank';
import { Button } from '../primitives/Button';
import { Table } from '../primitives/Table';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import { StatTile } from '../overview/OverviewScreen';
import type { StatTileModel } from '../overview/model';
import clsx from 'clsx';

export interface OrbitFlowStatModel {
  id: string;
  name: string;
  area: string;
  perMonth: string;
  toPerson: number;
  errors: string;
  /** «Call center · 4», or none. */
  stuck?: string;
}

function ShareBar({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-1.5 w-[88px] overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]" aria-hidden="true">
        <span className="block h-full rounded-full bg-primary dark:bg-primary-dark" style={{ width: `${value}%` }} />
      </span>
      <span className="tabular-nums">{value}%</span>
    </span>
  );
}

/**
 * The overview of ORBIT (s04): four headline numbers and every flow's month
 * side by side. Tiles and rows lead to what is behind them when their
 * handlers are passed.
 */
export function OrbitOverview({ tiles, flows, tileLinks, onOpenFlow, onOpenStuck, onExport, exportTitle, copy, phone }: {
  tiles: StatTileModel[];
  flows: OrbitFlowStatModel[];
  tileLinks?: ItemLinks;
  onOpenFlow: (id: string) => void;
  onOpenStuck: (id: string) => void;
  onExport: Action;
  exportTitle?: string;
  copy: UiCopy;
  phone?: boolean;
}) {
  const s = copy.orgs.orbit;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: s.overviewTitle, detail: s.overviewDetail }]}>
        <Button onClick={onExport} title={exportTitle}>{copy.overview.exportAll}</Button>
      </PaneHeader>
      <div className={clsx('min-h-0 flex-1 space-y-4 overflow-y-auto', phone ? 'px-4 py-4' : 'px-5 py-5')}>
        <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
          {tiles.map((t) => <StatTile key={t.id} tile={t} onOpen={tileLinks?.[t.id]} />)}
        </div>
        <Table
          ariaLabel={s.overviewTitle}
          columns={[
            { id: 'name', label: s.columns.flow, width: 300 },
            { id: 'area', label: s.columns.area, width: 120 },
            { id: 'perMonth', label: copy.overview.columns.perMonth, width: 110, align: 'right' },
            { id: 'toPerson', label: copy.overview.columns.toPerson, width: 160 },
            { id: 'errors', label: copy.overview.columns.errors, width: 72, align: 'right' },
            { id: 'stuck', label: copy.overview.columns.stuck, width: 160 },
          ]}
          rows={flows.map((f) => ({
            id: f.id,
            onOpen: () => onOpenFlow(f.id),
            cells: {
              name: <span className="font-semibold">{f.name}</span>,
              area: f.area,
              perMonth: f.perMonth,
              toPerson: <ShareBar value={f.toPerson} />,
              errors: f.errors,
              stuck: f.stuck ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenStuck(f.id); }}
                  className={clsx('rounded text-primary underline-offset-2 hover:underline dark:text-primary-dark', FOCUS_RING)}
                >
                  {f.stuck}
                </button>
              ) : <Blank />,
            },
          }))}
        />
      </div>
    </div>
  );
}
