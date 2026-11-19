/**
 * What the pages of «Dati» share about its tables: the tables with their
 * counts (the same rows the tables draw, so the same numbers as the kanban
 * and «Contratti»), the saved filters that come with each table, and what a
 * table starts as. A saved filter is a table with filters kept under a name;
 * the ones a person saves are kept by the filter bar itself.
 */
import type { TableNavItem } from '../../../../ui/data/model';
import type { SarimBuiltInView, SarimDataCopy } from '../../../../ui/copy/sarim-data';
import type { ScreenCtx } from '../../../app/kit';
import { SP } from '../../paths';
import { world } from '../../world';
import { EMPTY_FILTERS, type ListFilterState, type SavedFilter } from '../../../app/filters';
import { familyOf, isOpenCard, rowsOf, stageLabel, TABLE_IDS, type Filter, type Sort, type TableId } from './tables';

/** The saved filters of the tables of cards come from the world; the two of «Contratti» and «Comuni» are always there. */
const BUILT_IN: Array<{ id: SarimBuiltInView; table: TableId; filters: (s: SarimDataCopy) => Filter[] }> = [
  ...world().dataViews.map((v) => ({
    id: v.id,
    table: v.table,
    filters: (s: SarimDataCopy): Filter[] => [
      ...(v.stopped ? [{ col: 'stopped', op: 'not' as const, value: s.values.notStopped }] : []),
      ...(v.stage ? [{ col: 'stage', op: 'is' as const, value: stageLabel(v.stage) }] : []),
      ...(v.dueWithin ? [{ col: 'due', op: 'within' as const, value: String(v.dueWithin) }] : []),
    ],
  })),
  { id: 'noticeSoon', table: 'contratti', filters: () => [{ col: 'notice', op: 'within', value: '90' }] }, // allow-italian: address segment, compared by value
  /* Only an organization that has stopped serving a town has this view. */
  ...(world().towns.some((t) => t.past) ? [{ id: 'pastTowns', table: 'comuni', filters: (s: SarimDataCopy): Filter[] => [{ col: 'state', op: 'is', value: s.values.townPast }] }] : []), // allow-italian: address segment, compared by value
];

/** The saved filters that ship with a table, as the filter bar wants them. */
export function presetsOf(table: TableId, s: SarimDataCopy): SavedFilter[] {
  return BUILT_IN.filter((v) => v.table === table).map((v) => ({
    id: v.id,
    name: s.views.builtIn[v.id],
    tokens: v.filters(s).map((f, i) => ({ id: `p${i + 1}`, field: f.col, op: f.op, value: f.value })),
  }));
}

/** Opens a table already filtered by one of its saved filters: what a tile of the overview counts. */
export function openPreset(ctx: Pick<ScreenCtx, 'ui' | 'go' | 'copy'>, view: SarimBuiltInView) {
  const table = BUILT_IN.find((v) => v.id === view)?.table ?? TABLE_IDS[0];
  const preset = presetsOf(table, ctx.copy.sarimData).find((p) => p.id === view);
  if (preset) ctx.ui<ListFilterState>(tableFiltersKey(table), EMPTY_FILTERS)[1]({ query: '', tokens: preset.tokens, saved: view });
  ctx.go(SP.data(table));
}

/** The key the filters of a table are kept under (`ctx.ui`), so another screen can open it already filtered. */
export const tableFiltersKey = (t: TableId) => `sarim.data.${t}.filters`;

/** What a table starts as: cards grouped by stage, the nearest due day first; contracts by notice; towns by name. */
export function defaultsOf(t: TableId): { group: string; sort: Sort | null } {
  const family = familyOf(t);
  if (family === 'cards') return { group: 'stage', sort: { col: 'due', dir: 'asc' } };
  if (family === 'contracts') return { group: '', sort: { col: 'notice', dir: 'asc' } };
  return { group: '', sort: null };
}

export function tableNavItems(ctx: ScreenCtx): TableNavItem[] {
  const s = ctx.copy.sarimData;
  return TABLE_IDS.map((t) => {
    const rows = rowsOf(t, ctx.state, s, ctx.now);
    if (familyOf(t) === 'cards') {
      const open = rows.filter((r) => r.card && isOpenCard(r.card)).length;
      return { id: t, label: s.tables[t].label, count: String(rows.length), hint: s.nav.cardsHint(rows.length, open) };
    }
    return { id: t, label: s.tables[t].label, count: String(rows.length), hint: s.nav.rowsHint(rows.length) };
  });
}
