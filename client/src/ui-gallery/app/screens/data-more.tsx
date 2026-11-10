/**
 * The places of the `data-more` area: the tables (x01), their fields and
 * rules (x02), the types of data and their links (w04), the schedule of
 * deadlines (n14), data quality (q01) and one item in quarantine (q02).
 * See `../kit.ts` for the contract; the screens live in `./data-more/`.
 */
import { CalendarDays, Database, ListChecks, Network, ShieldAlert, ShieldCheck, Table2 } from 'lucide-react';
import { DEADLINES_TABLE, TABLE_METAS, VIEW_SEEDS, type ViewSeed } from '../../../ui/fixtures/data';
import { QUARANTINE } from '../../../ui/fixtures/quality';
import type { AreaModule, ScreenDef, SearchEntry } from '../kit';
import { P } from '../paths';
import { DeadlinesScreen } from './data-more/DeadlinesScreen';
import { FieldsScreen } from './data-more/FieldsScreen';
import { QualityScreen } from './data-more/QualityScreen';
import { QuarantineScreen } from './data-more/QuarantineScreen';
import { SchemaScreen } from './data-more/SchemaScreen';
import { TableScreen } from './data-more/TableScreen';
import { pendingItems, type QuarantineDecisions } from './data-more/quality';

const base = { org: 'nocera', nav: 'data', needs: 'view:data' } as const;

const tableTitle = (id: string) => TABLE_METAS.find((m) => m.id === id)?.label ?? id;

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'x01',
    path: '/dati',
    samples: ['/dati', '/dati/ricorsi', '/dati/vista/legale-aperte', '/dati/fatture', '/dati/contribuenti', '/dati/canali', '/dati/fornitori', '/dati/concessioni', '/dati/richieste-irrigue', '/dati/vista/scadono-30'],
    title: (_p, ctx) => ctx.copy.data.root,
    render: (_p, ctx) => <TableScreen ctx={ctx} table="pratiche" />,
  },
  {
    ...base,
    id: 'x01',
    path: '/dati/vista/:view',
    samples: ['/dati/vista/legale-aperte'],
    title: (p, ctx) => {
      const custom = (ctx.state.slices.dataViews as ViewSeed[] | undefined) ?? [];
      return [...VIEW_SEEDS, ...custom].find((v) => v.id === p.view)?.label ?? ctx.copy.data.root;
    },
    render: (p, ctx) => <TableScreen ctx={ctx} table="pratiche" viewId={p.view} />,
  },
  {
    ...base,
    id: 'x01',
    path: '/dati/:table',
    samples: ['/dati/ricorsi'],
    title: (p) => tableTitle(p.table),
    render: (p, ctx) => <TableScreen ctx={ctx} table={p.table} />,
  },
  {
    ...base,
    id: 'x02',
    path: '/dati/:table/campi',
    samples: ['/dati/ricorsi/campi', '/dati/pratiche/campi', '/dati/fatture/campi', '/dati/fornitori/campi'],
    title: (p, ctx) => `${tableTitle(p.table)} · ${ctx.copy.dataMore.fields.crumb}`,
    render: (p, ctx) => <FieldsScreen ctx={ctx} table={p.table} />,
  },
  {
    ...base,
    id: 'w04',
    path: '/dati/schema',
    samples: ['/dati/schema'],
    title: (_p, ctx) => ctx.copy.dataMore.schema.crumb,
    render: (_p, ctx) => <SchemaScreen ctx={ctx} />,
  },
  {
    ...base,
    id: 'n14',
    path: '/dati/scadenzario',
    samples: ['/dati/scadenzario'],
    title: () => DEADLINES_TABLE.label,
    render: (_p, ctx) => <DeadlinesScreen ctx={ctx} />,
  },
  {
    ...base,
    id: 'q01',
    path: '/dati/qualita',
    samples: ['/dati/qualita'],
    title: (_p, ctx) => ctx.copy.dataMore.quality.crumb,
    render: (_p, ctx) => <QualityScreen ctx={ctx} />,
  },
  {
    ...base,
    id: 'q02',
    path: '/dati/qualita/:id',
    samples: ['/dati/qualita/q-iban', '/dati/qualita/q-notifica-2409', '/dati/qualita/q-importo-1203', '/dati/qualita/q-piva-1190'],
    title: (p) => QUARANTINE.find((q) => q.id === p.id)?.title ?? p.id,
    render: (p, ctx) => <QuarantineScreen ctx={ctx} id={p.id} />,
  },
];

export const DATA_AREA: AreaModule = {
  screens: SCREENS,
  search: (ctx): SearchEntry[] => {
    const s = ctx.copy.dataMore.search;
    const custom = (ctx.state.slices.dataViews as ViewSeed[] | undefined) ?? [];
    const decisions = (ctx.state.slices.quarantine as QuarantineDecisions | undefined) ?? {};
    return [
      ...TABLE_METAS.map((m): SearchEntry => ({
        id: `table-${m.id}`, group: s.tables, title: m.label, detail: m.summary, path: m.id === 'pratiche' ? P.data() : P.data(m.id), icon: Database, needs: 'view:data',
      })),
      { id: 'table-deadlines', group: s.tables, title: DEADLINES_TABLE.label, detail: s.deadlinesDetail, keywords: s.deadlinesKeywords, path: P.deadlines(), icon: CalendarDays, needs: 'view:data' },
      ...[...VIEW_SEEDS, ...custom].map((v): SearchEntry => ({
        id: `view-${v.id}`, group: s.views, title: v.label, detail: tableTitle(v.table), path: P.dataView(v.id), icon: Table2, needs: 'view:data',
      })),
      { id: 'data-schema', group: s.pages, title: ctx.copy.dataMore.schema.crumb, detail: ctx.copy.dataMore.schema.crumbDetail, keywords: s.schemaKeywords, path: P.dataSchema(), icon: Network, needs: 'view:data' },
      { id: 'data-fields', group: s.pages, title: ctx.copy.dataMore.fields.crumb, keywords: s.fieldsKeywords, path: P.dataFields('ricorsi'), icon: ListChecks, needs: 'view:data' },
      { id: 'data-quality', group: s.pages, title: ctx.copy.dataMore.quality.crumb, detail: s.qualityDetail, keywords: s.qualityKeywords, path: P.quality(), icon: ShieldCheck, needs: 'view:data' },
      ...pendingItems(decisions).map((q): SearchEntry => ({
        id: `quarantine-${q.id}`, group: s.quarantine, title: q.title, detail: q.where, keywords: q.summary, path: P.qualityItem(q.id), icon: ShieldAlert, needs: 'view:data',
      })),
    ];
  },
};
