/**
 * ORBIT edition, area «Dati»: the tables composed from the live world (one (allow-italian: quotes the Italian interface)
 * row per kanban card of each flow, one per contract, one per town served),
 * one row of any of them, and the schedule of every deadline. The words are in
 * `ctx.copy.orbitData`, the towns in `fixtures/orbit-org/data.ts`.
 */
import { townById, world } from '../world';
import type { AreaModule, ScreenDef } from '../../app/kit';
import { liveCardById, liveContractById } from '../model/live';
import { SP } from '../paths';
import { DeadlinesScreen } from './data/DeadlinesScreen';
import { RowScreen } from './data/RowScreen';
import { OverviewScreen, TableScreen } from './data/TableScreen';
import { isTable } from './data/tables';

const base = { org: world().key, nav: 'knowledge', needs: 'view:data' } as const;

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'orbit-data',
    path: '/conoscenza/dati',
    tabKey: () => 'orbit:knowledge',
    samples: [SP.data()],
    title: (_p, ctx) => ctx.copy.orbitData.title,
    render: (_p, ctx) => <OverviewScreen ctx={ctx} />,
  },
  {
    ...base,
    id: 'orbit-deadlines',
    path: '/conoscenza/dati/scadenzario', // allow-italian: address segment, not shown
    tabKey: () => 'orbit:knowledge',
    samples: [SP.deadlines()],
    tab: (_p, ctx) => ({ label: ctx.copy.orbitData.deadlines.title }),
    title: (_p, ctx) => ctx.copy.orbitData.deadlines.title,
    render: (_p, ctx) => <DeadlinesScreen ctx={ctx} view="list" />,
  },
  {
    ...base,
    id: 'orbit-deadlines-month',
    path: '/conoscenza/dati/scadenzario/mese', // allow-italian: address segment, not shown
    tabKey: () => 'orbit:knowledge',
    samples: [SP.deadlinesMonth()],
    tab: (_p, ctx) => ({ label: ctx.copy.orbitData.deadlines.title }),
    title: (_p, ctx) => ctx.copy.orbitData.deadlines.title,
    render: (_p, ctx) => <DeadlinesScreen ctx={ctx} view="month" />,
  },
  {
    ...base,
    id: 'orbit-data',
    path: '/conoscenza/dati/:table',
    tabKey: () => 'orbit:knowledge',
    samples: world().samples.dataTables.map((t) => SP.data(t)),
    title: (p, ctx) => (isTable(p.table) ? ctx.copy.orbitData.tables[p.table].label : ctx.copy.orbitData.title),
    render: (p, ctx) => <TableScreen ctx={ctx} table={p.table} view="table" />,
  },
  {
    ...base,
    id: 'orbit-data-board',
    path: '/conoscenza/dati/:table/bacheca', // allow-italian: address segment, not shown
    tabKey: () => 'orbit:knowledge',
    samples: world().samples.dataBoards.map((t) => SP.dataView(t, 'board')),
    title: (p, ctx) => (isTable(p.table) ? ctx.copy.orbitData.tables[p.table].label : ctx.copy.orbitData.title),
    render: (p, ctx) => <TableScreen ctx={ctx} table={p.table} view="board" />,
  },
  {
    ...base,
    id: 'orbit-data-chart',
    path: '/conoscenza/dati/:table/grafico', // allow-italian: address segment, not shown
    tabKey: () => 'orbit:knowledge',
    samples: world().samples.dataCharts.map((t) => SP.dataView(t, 'chart')),
    title: (p, ctx) => (isTable(p.table) ? ctx.copy.orbitData.tables[p.table].label : ctx.copy.orbitData.title),
    render: (p, ctx) => <TableScreen ctx={ctx} table={p.table} view="chart" />,
  },
  {
    ...base,
    id: 'orbit-data-row',
    path: '/conoscenza/dati/:table/:row',
    samples: world().samples.dataRows.map(([table, row]) => SP.dataRow(table, row)),
    tabKey: () => 'orbit:knowledge',
    tab: (p, ctx) => ({ label: rowTitle(p, ctx) ?? p.row }),
    title: (p, ctx) => rowTitle(p, ctx) ?? p.row,
    render: (p, ctx) => <RowScreen ctx={ctx} table={p.table} rowId={p.row} />,
  },
];

function rowTitle(p: Record<string, string>, ctx: Parameters<ScreenDef['title']>[1]): string | undefined {
  if (!isTable(p.table)) return undefined;
  if (p.table === 'contratti') return liveContractById(ctx.state, p.row)?.title; // allow-italian: address segment, compared by value
  if (p.table === 'comuni') return townById(p.row)?.name; // allow-italian: address segment, compared by value
  const card = liveCardById(ctx.state, p.row);
  return card ? `${card.id} · ${card.title}` : undefined;
}

export const ORBIT_DATA_AREA: AreaModule = {
  screens: SCREENS,
};
