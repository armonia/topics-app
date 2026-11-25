/**
 * The filters of one table of «Dati»: the fields come from its columns (a
 * choice for the ones that offer values, a date for the ones with a day), the
 * search reads every text of a row. The same state is read by the table, the
 * board, the chart and the row page, so they all walk the same rows.
 */
import { Bolt, CalendarDays, CircleDot, CirclePause, Flag, MapPin, Tag, User, Workflow, type LucideIcon } from 'lucide-react';
import type { OrbitDataCopy } from '../../../../ui/copy/orbit-data';
import { EMPTY_FILTERS, applyFilters, type FilterSchema, type ListFilterState } from '../../../app/filters';
import type { ScreenCtx } from '../../../app/kit';
import { columnsOf, groupRows, rowsOf, sortRows, type DataRow, type Sort, type TableId } from './tables';
import { defaultsOf, tableFiltersKey } from './nav';

const FIELD_ICON: Record<string, LucideIcon> = {
  stage: CircleDot, worker: Bolt, reviewer: User, place: MapPin, due: CalendarDays, priority: Flag, stopped: CirclePause, flow: Workflow, end: CalendarDays, notice: CalendarDays,
};

/** The fields a table can be filtered by, one per column that offers a filter. */
export function tableSchema(t: TableId, s: OrbitDataCopy): FilterSchema<DataRow> {
  return {
    text: (r) => [r.id, r.title, ...Object.values(r.text)].join(' '),
    fields: columnsOf(t, s, []).filter((c) => c.filter).map((c) => (c.filter === 'within'
      ? { id: c.id, label: c.label, icon: FIELD_ICON[c.id] ?? CalendarDays, kind: 'date' as const, ops: ['within' as const, 'before' as const, 'after' as const], get: (r: DataRow) => r.day[c.id] }
      : { id: c.id, label: c.label, icon: FIELD_ICON[c.id] ?? Tag, kind: 'choice' as const, get: (r: DataRow) => r.text[c.id] })),
  };
}

/** The rows in the order the table shows them now (its filters, group and order); all of them if the row fell out. */
export function rowsInView(ctx: ScreenCtx, t: TableId, rowId: string): DataRow[] {
  const s = ctx.copy.orbitData;
  const [filters] = ctx.ui<ListFilterState>(tableFiltersKey(t), EMPTY_FILTERS);
  const base = defaultsOf(t);
  const [group] = ctx.ui<string>(`orbit.data.t.${t}.group`, base.group);
  const [sort] = ctx.ui<Sort | null>(`orbit.data.t.${t}.sort`, base.sort);
  const all = rowsOf(t, ctx.state, s, ctx.now);
  const list = groupRows(sortRows(applyFilters(all, tableSchema(t, s), filters, ctx.now), sort), group).flatMap((g) => g.rows);
  return list.some((r) => r.id === rowId) ? list : all;
}
