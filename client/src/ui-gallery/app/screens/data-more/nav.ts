/**
 * The left column of the data pages: the tables, the saved views and the
 * pages that belong to data. Counts come from the same rows the tables draw.
 */
import { Network, ShieldCheck } from 'lucide-react';
import type { NavLinkModel } from '../../../../ui/data/TablesNav';
import type { TableNavItem } from '../../../../ui/data/model';
import { DECLARED_TOTALS, DEADLINES_TABLE, PROGRAM_NAME, TABLE_METAS, type ViewSeed } from '../../../../ui/fixtures/data';
import type { ScreenCtx } from '../../kit';
import { applyView, isCaseTable, type EngineRow } from './engine';

export type RowsFor = (table: string) => EngineRow[];

export function tableNavItems(ctx: ScreenCtx, rowsFor: RowsFor): TableNavItem[] {
  const fmt = new Intl.NumberFormat(ctx.copy.dataMore.format.locale);
  const items = TABLE_METAS.map((m) => ({
    id: m.id,
    label: m.label,
    count: m.total ? fmt.format(m.total) : m.home !== 'topics' ? PROGRAM_NAME[m.home] : fmt.format(rowsFor(m.id).length),
  }));
  items.splice(1, 0, { id: DEADLINES_TABLE.id, label: DEADLINES_TABLE.label, count: fmt.format(DECLARED_TOTALS.scadenze) });
  return items;
}

export function viewNavItems(ctx: ScreenCtx, views: ViewSeed[], rowsFor: RowsFor): TableNavItem[] {
  const t = ctx.copy.dataMore.nav;
  return views.map((v) => {
    const n = applyView(rowsFor(v.table), v.filters, v.q ?? '', v.rule, ctx.persona).length;
    const table = TABLE_METAS.find((m) => m.id === v.table)?.label ?? v.table;
    return { id: v.id, label: v.label, count: String(n), hint: !isCaseTable(v.table) ? t.viewRowsHint(n, table)
      // Only a view that filters on the deadline invites the comparison with the deadlines table.
      : v.filters.some((f) => f.col === 'scadenza') ? `${t.viewCasesHint(n)} ${t.viewDeadlinesNote}` : t.viewCasesHint(n) };
  });
}

export function dataLinks(ctx: ScreenCtx, current?: 'schema' | 'quality'): NavLinkModel[] {
  const t = ctx.copy.dataMore.nav;
  return [
    { id: 'schema', label: t.schema, icon: Network, current: current === 'schema' },
    { id: 'quality', label: t.quality, icon: ShieldCheck, current: current === 'quality' },
  ];
}
