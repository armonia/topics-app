/**
 * sarim-data: «Dati» of SARIM. `/conoscenza/dati` is the overview (what is open, what is (allow-italian: quotes the Italian interface)
 * stopped, the contracts, what falls due this week, every table with its
 * counts); `/conoscenza/dati/:table` is one table with the filter bar, the
 * grouping and the order, the columns to show, the ticked rows to give to
 * someone or export. Its three ways to look (table, board by stage, chart)
 * are three addresses (`/:table`, `/:table/bacheca`, `/:table/grafico`) and a
 * row opens its own page. The filters stay in the container (`ctx.ui`), so a
 * reload lands where the reader left.
 */
import { useMemo, useState } from 'react';
import { CalendarClock, CircleDot, Columns3, Database, Download, FileSearch, SquareKanban, UserPlus, X } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../../../../ui/primitives/Button';
import { StatCard } from '../../../../ui/primitives/Card';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Checkbox, Select } from '../../../../ui/primitives/Field';
import { MenuButton } from '../../../../ui/primitives/Menu';
import { Popover } from '../../../../ui/primitives/Popover';
import { Table } from '../../../../ui/primitives/Table';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { ViewSwitch } from '../../../../ui/kanban/KanbanHeader';
import { BackButton, PaneHeader } from '../../../../ui/shell/PaneHeader';
import { TableGrid } from '../../../../ui/data/TableGrid';
import { ContractList } from '../../../../ui/contracts/ContractList';
import { StatusBoard } from '../../../../ui/data/StatusBoard';
import { GroupChart } from '../../../../ui/data/GroupChart';
import type { ChartBarModel, GridModel, StatusColumnModel } from '../../../../ui/data/model';
import type { StageGlyph } from '../../../../ui/kanban/model';
import type { Tone } from '../../../../ui/types';
import { teamById, teamIdOfPerson, world } from '../../world';
import type { SarimCard } from '../../../../ui/fixtures/sarim-org/types';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema } from '../../../app/filters';
import { KANBAN_INITIAL, KANBAN_SLICE, liveCards, liveContracts, withWorker, type KanbanSlice } from '../../model/live';
import { stuckCards } from '../../model/stages';
import { openDaFare } from '../../model/dafare';
import { contractAlerts } from '../../model/contracts';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { row as contractRow } from '../contracts/rows';
import { KnowledgeNav } from '../knowledge/KnowledgeNav';
import { allDeadlines, dueWithin, openWeek } from './deadlines';
import { tableSchema } from './filters';
import { defaultsOf, openPreset, presetsOf, tableFiltersKey, tableNavItems } from './nav';
import {
  cardsOfTable, columnsOf, downloadText, dueTone, familyOf, flowOfTable, groupRows, isOpenCard, isTable, openExternal, rowsOf,
  sortRows, STAGE_TONE, STATUS_TONE, toCsv, type Sort, type TableFamily, type TableId,
} from './tables';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';

const CHART_TONES: Tone[] = ['blue', 'violet', 'amber', 'pink', 'green', 'red', 'neutral'];

/** The glyph a stage wears in the inbox, so the board here draws the same one. */
const STAGE_GLYPH: Record<string, StageGlyph> = { arrivo: 'incoming', lavorazione: 'working', verifica: 'check', approvazione: 'approve', fatto: 'done' }; // allow-italian: stage ids of the data

/** The data view switch reuses the icons the inbox switch gives to the same two shapes: rows and columns. */
const SWITCH_ID: Record<DataView, string> = { table: 'list', board: 'kanban', chart: 'chart' };
const FROM_SWITCH: Record<string, DataView> = { list: 'table', kanban: 'board', chart: 'chart' };

/** One table of the overview: its counts, and the family it belongs to. */
interface TableTile {
  id: TableId;
  label: string;
  about: string;
  family: TableFamily;
  rows: number;
  open: number;
  stopped: number;
}

/* ---------------- /conoscenza/dati ---------------- */

export function OverviewScreen({ ctx }: { ctx: ScreenCtx }) {
  const s = ctx.copy.sarimData;
  const o = s.overview;
  const today = ctx.now.slice(0, 10);
  const cards = liveCards(ctx.state);
  const contracts = liveContracts(ctx.state);
  const open = cards.filter(isOpenCard).length;
  const stopped = stuckCards(cards, ctx.now).length;
  /* the notices «Contratti» warns about (within 90 days), through the same function (allow-italian: quotes the Italian interface) */
  const notices = contracts.filter((c) => contractAlerts(c, today, cards).some((a) => a.kind === 'preavviso')).length; // allow-italian: alert kind, compared by value
  const week = dueWithin(allDeadlines(ctx.state, today), today);
  const weekCards = week.filter((d) => d.card).length;
  const tiles: TableTile[] = tableNavItems(ctx).map((item) => {
    const t = item.id as TableId;
    const tableCards = cardsOfTable(ctx.state, t);
    const family = familyOf(t);
    return {
      id: t,
      label: item.label,
      about: s.tables[t].about,
      family,
      rows: Number(item.count),
      open: family === 'cards' ? tableCards.filter(isOpenCard).length : 0,
      stopped: family === 'cards' ? stuckCards(tableCards, ctx.now).length : 0,
    };
  });

  const schema = useMemo<FilterSchema<TableTile>>(() => ({
    text: (x) => `${x.label} ${x.about}`,
    fields: [
      { id: 'tipo', label: o.fields.kind, icon: Database, kind: 'choice', get: (x) => x.family, valueLabel: (v) => o.kinds[v as TableFamily], order: ['cards', 'contracts', 'towns'] },
      { id: 'ferme', label: o.fields.stopped, icon: CircleDot, kind: 'choice', ops: ['is'], get: (x) => (x.family === 'cards' ? (x.stopped ? 'yes' : 'no') : []), valueLabel: (v) => (v === 'yes' ? s.common.yes : s.common.no), order: ['yes', 'no'] },
    ],
  }), [o, s.common.yes, s.common.no]);
  const list = useListFilters(ctx, { key: 'sarim.data.filters', items: tiles, schema });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: s.knowledge.title, to: SP.knowledge() }, { label: s.title }])}>
        <Button icon={CalendarClock} onClick={() => ctx.go(SP.deadlines())}>{s.nav.deadlines}</Button>
      </PaneHeader>
      <KnowledgeNav ctx={ctx} active="data" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className={`min-w-0 space-y-4 ${PAGE_GUTTER} py-4`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={o.stats.open} value={open} detail={o.stats.openDetail} onOpen={() => ctx.go(SP.inbox())} />
            <StatCard label={o.stats.stopped} value={stopped} tone={stopped ? 'red' : undefined} detail={o.stats.stoppedDetail} onOpen={() => openDaFare(ctx, { view: 'stages' })} />
            <StatCard label={o.stats.contracts} value={contracts.length} detail={o.stats.contractsDetail(notices)} onOpen={() => openPreset(ctx, 'noticeSoon')} />
            <StatCard label={o.stats.deadlines} value={week.length} detail={o.stats.deadlinesDetail(weekCards, week.length - weekCards)} onOpen={() => openWeek(ctx)} />
          </div>
          <FilterBar copy={ctx.copy} {...list.bar} placeholder={ctx.copy.filters.on.tables} phone={ctx.phone} />
          {list.items.length === 0 ? (
            <EmptyState icon={FileSearch} title={o.empty.title} className="min-h-0 rounded-lg border border-app-border bg-surface py-10">{o.empty.body}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table
                ariaLabel={o.tableLabel}
                columns={[
                  { id: 'table', label: o.columns.table, width: 220 },
                  { id: 'rows', label: o.columns.rows, width: 80, align: 'right' },
                  { id: 'open', label: o.columns.open, width: 80, align: 'right' },
                  { id: 'stopped', label: o.columns.stopped, width: 80, align: 'right' },
                  { id: 'about', label: o.columns.about },
                ]}
                rows={list.items.map((x) => ({
                  id: x.id,
                  onOpen: () => ctx.go(SP.data(x.id)),
                  cells: {
                    table: <span data-table={x.id} className="inline-flex items-center gap-2 font-medium text-app-text"><Database size={14} className="text-app-text-tertiary" aria-hidden="true" />{x.label}</span>,
                    rows: <span className="tabular-nums">{x.rows}</span>,
                    /* A table with no open or stopped card says «-», as the tables of towns and contracts do: never a zero beside a dash. */
                    open: x.open ? <span className="tabular-nums">{x.open}</span> : <span className="text-app-text-faint">{s.common.blank}</span>,
                    stopped: x.stopped
                      ? <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">{x.stopped}</span>
                      : <span className="text-app-text-faint">{s.common.blank}</span>,
                    about: <span className="text-app-text-secondary">{x.about}</span>,
                  },
                }))}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------------- /conoscenza/dati/:table ---------------- */

type DataView = 'table' | 'board' | 'chart';

const VIEW_PATH: Record<DataView, (t: TableId) => string> = {
  table: (t) => SP.data(t),
  board: (t) => SP.dataView(t, 'board'),
  chart: (t) => SP.dataView(t, 'chart'),
};

export function TableScreen({ ctx, table, view }: { ctx: ScreenCtx; table: string; view: DataView }) {
  const s = ctx.copy.sarimData;
  if (!isTable(table)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeader crumbs={orgCrumbs(ctx, [{ label: s.knowledge.title, to: SP.knowledge() }, { label: s.title }])} />
        <KnowledgeNav ctx={ctx} active="data" />
        <EmptyState icon={Database} title={s.table.notFound.title} action={<Button variant="primary" onClick={() => ctx.go(SP.data())}>{s.table.notFound.back}</Button>}>
          {s.table.notFound.body}
        </EmptyState>
      </div>
    );
  }
  return <TableView ctx={ctx} t={table} view={view} />;
}

function TableView({ ctx, t, view }: { ctx: ScreenCtx; t: TableId; view: DataView }) {
  const s = ctx.copy.sarimData;
  const d = ctx.copy.dataMore;
  const base = defaultsOf(t);
  const [picker, setPicker] = useState(false);
  const [sort, setSort] = ctx.ui<Sort | null>(`sarim.data.t.${t}.sort`, base.sort);
  const [group, setGroup] = ctx.ui<string>(`sarim.data.t.${t}.group`, base.group);
  const [selected, setSelected] = ctx.ui<string[]>(`sarim.data.t.${t}.selected`, []);
  const columns = columnsOf(t, s, cardsOfTable(ctx.state, t));
  const initialCols = columns.filter((c) => c.shown).map((c) => c.id);
  const [visible, setVisible] = ctx.ui<string[]>(`sarim.data.t.${t}.cols`, initialCols);
  const sameCols = visible.length === initialCols.length && initialCols.every((id) => visible.includes(id));
  const groupColumns = columns.filter((c) => c.group);
  const [chartBy, setChartBy] = ctx.ui<string>(`sarim.data.t.${t}.chartBy`, groupColumns[0]?.id ?? '');
  const all = rowsOf(t, ctx.state, s, ctx.now);
  const schema = useMemo(() => tableSchema(t, s), [t, s]);
  const presets = useMemo(() => presetsOf(t, s), [t, s]);
  const list = useListFilters(ctx, { key: tableFiltersKey(t), items: all, schema, presets });

  const family = familyOf(t);
  const label = s.tables[t].label;
  const flow = flowOfTable(t);
  const today = ctx.now.slice(0, 10);
  const shown = useMemo(() => sortRows(list.items, sort), [list.items, sort]);
  const rowsById = new Map(all.map((r) => [r.id, r]));
  const shownCols = columns.filter((c) => c.fixed || visible.includes(c.id));
  const groups = groupRows(shown, view === 'table' ? group : '');
  const selectedShown = selected.filter((id) => shown.some((r) => r.id === id));

  const grid: GridModel = {
    columns: shownCols.map((c) => ({ id: c.id, label: c.label, width: c.width, sortable: true })),
    groups: groups.map((g) => ({
      id: g.id,
      label: group && view === 'table' ? `${g.label || s.common.blank} · ${s.common.rows(g.rows.length)}` : '',
      rows: g.rows.map((r) => ({ id: r.id, cells: r.cells, opens: true })),
    })),
  };

  /* ---- where things lead ---- */
  const goLink = (target: string) => (target.startsWith('https://') ? openExternal(ctx, target) : ctx.go(target));
  const openRow = (id: string) => ctx.go(SP.dataRow(t, id));
  const openCell = (rowId: string, col: string) => {
    const target = rowsById.get(rowId)?.links[col];
    if (target) goLink(target);
    else openRow(rowId);
  };

  /* ---- order and group ---- */
  const sortColumn = (col: string) => setSort((prev) => (prev?.col === col ? (prev.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' }));

  /* ---- actions ---- */
  const exportRows = (ids?: string[]) => {
    const part = shown.filter((r) => !ids || ids.includes(r.id));
    const csv = toCsv(shownCols.map((c) => c.label), part.map((r) => shownCols.map((c) => r.text[c.id] ?? '')));
    const name = s.table.file(t, today);
    downloadText(name, csv);
    ctx.log(s.table.logExported(part.length, s.tables[t].label), 'share', SP.data(t));
    ctx.toast({ tone: 'ok', title: s.table.exported(part.length), body: name });
  };
  const people = world().people.personas.filter((p) => p.role !== world().people.viewerRole).map((p) => ({ id: p.id, label: p.short, hint: teamById(teamIdOfPerson(p.id) ?? p.area)?.label }));
  const assign = (personId: string) => {
    const person = world().people.personas.find((p) => p.id === personId);
    if (!person || !ctx.can('edit:data')) return;
    const part = selectedShown.map((id) => rowsById.get(id)?.card).filter((c): c is SarimCard => c !== undefined);
    const [, setKanban] = ctx.slice<KanbanSlice>(KANBAN_SLICE, KANBAN_INITIAL);
    setKanban((prev) => part.reduce((acc, c) => withWorker(acc, c.id, { kind: 'person', id: person.id, doing: s.table.assignDoing, since: ctx.now }), { ...KANBAN_INITIAL, ...prev }));
    for (const c of part) ctx.log(s.table.logAssigned(c.id, person.short), 'case', SP.card(c.id));
    ctx.toast({ tone: 'ok', title: s.table.assigned(part.length, person.short), action: flow ? { label: s.table.openKanban, path: SP.inboxKanban() } : undefined });
    setSelected([]);
  };

  /* ---- the three ways to look ---- */
  const boardCol = family === 'cards' ? 'stage' : family === 'contracts' ? 'status' : 'state';
  const board: StatusColumnModel[] = family === 'cards'
    ? world().stages.map((st) => ({
      id: st.id,
      label: st.label,
      tone: STAGE_TONE[st.id],
      glyph: STAGE_GLYPH[st.id],
      cards: shown.filter((r) => r.text.stage === st.label).map((r) => {
        /* the due day and the stopped mark read as in «Da fare»: the day by how near it is, the stop on its own chip and edge (allow-italian: quotes the Italian interface) */
        const stop = r.cells.stopped;
        return {
          id: r.id,
          title: r.title,
          detail: [r.text.worker, r.text.place].filter(Boolean).join(' · '),
          deadline: r.text.due || undefined,
          deadlineTone: r.card?.due ? dueTone(r.card.due, today, isOpenCard(r.card)) : undefined,
          stuck: stop.kind === 'text' && (stop.tone === 'red' || stop.tone === 'amber') ? { text: stop.text, tone: stop.tone } : undefined,
        };
      }),
    }))
    : groupRows(shown, boardCol).map((g) => ({
      id: g.id,
      label: g.label,
      tone: g.rows[0]?.contract ? STATUS_TONE[g.rows[0].contract.status] : g.rows[0]?.town?.past ? 'neutral' : 'green',
      cards: g.rows.map((r) => ({ id: r.id, title: r.title, detail: r.contract ? r.contract.counterparty : r.text.service, deadline: r.text.notice && r.contract && r.day.notice ? r.text.notice : undefined })),
    }));
  const by = groupColumns.some((c) => c.id === chartBy) ? chartBy : groupColumns[0]?.id ?? '';
  /* a bar wears what its state wears everywhere else: by stage, the glyph ink of the stage (the table «Da fare» draws its icons from); by contract status, the status' tone; any other column falls back to the palette (allow-italian: quotes the Italian interface) */
  const barStyle = (g: { label: string; rows: typeof shown }, i: number): Pick<ChartBarModel, 'tone' | 'glyph'> => {
    if (by === 'stage') {
      const st = world().stages.find((x) => x.label === g.label);
      if (st) return { tone: STAGE_TONE[st.id], glyph: STAGE_GLYPH[st.id] };
    }
    if (by === 'status' && g.rows[0]?.contract) return { tone: STATUS_TONE[g.rows[0].contract.status] };
    return { tone: CHART_TONES[i % CHART_TONES.length] };
  };
  const bars: ChartBarModel[] = groupRows(shown, by).map((g, i) => ({ id: g.label, label: g.label || s.common.blank, value: g.rows.length, ...barStyle(g, i) }));
  /* a bar is a filter on its column: the table opens already narrowed to it */
  const openBar = (value: string) => {
    if (schema.fields.some((f) => f.id === by)) {
      for (const tk of list.state.tokens.filter((x) => x.field === by)) list.bar.onRemoveToken(tk.id);
      list.bar.onAddToken({ field: by, op: 'is', value });
    }
    ctx.go(SP.data(t));
  };

  const empty = shown.length === 0;
  const body = empty && (list.state.tokens.length > 0 || list.state.query) ? (
    <EmptyState icon={FileSearch} title={d.empty.title} action={<Button variant="primary" onClick={list.bar.onClear}>{d.empty.clear}</Button>}>{d.empty.body}</EmptyState>
  ) : empty ? (
    <EmptyState icon={Database} title={d.empty.noRows} />
  ) : view === 'table' && ctx.phone && family === 'contracts' ? (
    /* an amount is never cut: at the phone the contracts are the same cards as in Contratti, one per contract */
    <ContractList phone rows={shown.flatMap((r) => (r.contract ? [contractRow(ctx, r.contract)] : []))} onOpen={openRow} copy={ctx.copy} />
  ) : view === 'table' ? (
    <TableGrid
      model={grid}
      copy={ctx.copy}
      sort={sort}
      onSort={sortColumn}
      selectedIds={selectedShown}
      onToggleRow={(id) => setSelected(selectedShown.includes(id) ? selectedShown.filter((x) => x !== id) : [...selectedShown, id])}
      onToggleAll={() => setSelected(selectedShown.length === shown.length ? [] : shown.map((r) => r.id))}
      onOpenRow={openRow}
      onOpenCell={openCell}
    />
  ) : view === 'board' ? (
    <div className="overflow-x-auto"><StatusBoard columns={board} copy={ctx.copy} onOpen={openRow} /></div>
  ) : (
    <GroupChart bars={bars} copy={ctx.copy} onBar={openBar} />
  );

  const views = (['table', 'board', 'chart'] as const).map((v) => ({ id: SWITCH_ID[v], label: s.table.views[v] }));
  const controls = (
    <>
      <ViewSwitch views={views} active={SWITCH_ID[view]} label={s.table.viewsLabel} compact={ctx.phone} onPick={(id) => ctx.go(VIEW_PATH[FROM_SWITCH[id] ?? 'table'](t))} />
      <span className="relative inline-flex">
        <Button icon={Columns3} onClick={() => setPicker((v) => !v)}>{s.table.columnsButton}</Button>
        {picker && (
          <Popover ariaLabel={s.table.columnsTitle} onClose={() => setPicker(false)} align="right" className="w-[290px] p-3">
            <p className="mb-2 text-compact font-semibold text-app-text">{s.table.columnsTitle}</p>
            <div className="flex max-h-[320px] flex-col items-start gap-1 overflow-y-auto pr-1">
              {columns.map((c) => (
                <Checkbox
                  key={c.id}
                  checked={Boolean(c.fixed) || visible.includes(c.id)}
                  disabled={c.fixed}
                  label={c.label}
                  onChange={(on) => setVisible(on ? [...visible.filter((x) => x !== c.id), c.id] : visible.filter((x) => x !== c.id))}
                />
              ))}
            </div>
            <div className="mt-2 flex justify-end"><Button size="sm" variant="ghost" onClick={sameCols ? false : () => setVisible(initialCols)}>{s.table.columnsReset}</Button></div>
          </Popover>
        )}
      </span>
      <Button icon={Download} onClick={ctx.allow('export', () => exportRows())} title={ctx.deniedTitle('export')}>{s.table.exportCsv}</Button>
      {flow && <Button icon={SquareKanban} onClick={() => openDaFare(ctx, { view: 'kanban', flow })}>{s.table.openKanban}</Button>}
      {family === 'contracts' && <Button onClick={() => ctx.go(SP.contracts())}>{s.table.openContracts}</Button>}
    </>
  );

  /* group (table) or the column a chart counts by (chart): the only two choices that are not filters */
  const trailing = view === 'table' && groupColumns.length > 0 ? (
    <Select
      size="sm"
      title={s.table.groupLabel}
      value={group || 'none'}
      options={[{ value: 'none', label: d.toolbar.groupBy(d.toolbar.noGroup) }, ...groupColumns.map((c) => ({ value: c.id, label: d.toolbar.groupBy(c.label) }))]}
      onChange={(v) => setGroup(v === 'none' ? '' : v)}
    />
  ) : view === 'chart' && groupColumns.length > 0 ? (
    <Select size="sm" title={d.chart.by} value={by} options={groupColumns.map((c) => ({ value: c.id, label: c.label }))} onChange={setChartBy} />
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" data-table-view={view}>
      <PaneHeader
        /* on the desk the crumb «Dati» already leads back; the arrow is for the phone, which shows only the last crumb */
        leading={ctx.phone ? <BackButton label={s.title} copy={ctx.copy} onClick={() => ctx.go(SP.data())} /> : undefined}
        crumbs={orgCrumbs(ctx, [{ label: s.knowledge.title, to: SP.knowledge() }, { label: s.title, to: SP.data() }, { label, detail: s.table.footer(shown.length, all.length) }])}
      >
        {!ctx.phone && controls}
      </PaneHeader>
      <KnowledgeNav ctx={ctx} active="data" />
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-4 py-2">{controls}</div>}
      <div className={clsx('min-h-0 flex-1 overflow-y-auto')}>
        <section className={`min-w-0 space-y-3 ${PAGE_GUTTER} py-3`}>
          <FilterBar copy={ctx.copy} {...list.bar} placeholder={ctx.copy.filters.on.rows} phone={ctx.phone} trailing={trailing} />
          {body}
          {selectedShown.length > 0 && view === 'table' && (
            <div role="toolbar" aria-label={s.table.selection.label} className="flex flex-wrap items-center gap-2 rounded-lg border border-app-border bg-surface px-3 py-2">
              <span className="mr-1 text-prose font-semibold text-app-text">{s.table.selection.count(selectedShown.length)}</span>
              {family === 'cards' && (
                <MenuButton
                  size="sm"
                  icon={UserPlus}
                  label={s.table.selection.assign}
                  items={people}
                  onSelect={assign}
                  disabled={!ctx.can('edit:data')}
                  title={ctx.can('edit:data') ? undefined : s.table.selection.assignDenied}
                />
              )}
              <Button size="sm" icon={Download} onClick={ctx.allow('export', () => exportRows(selectedShown))} title={ctx.deniedTitle('export')}>{s.table.selection.export}</Button>
              <Button size="sm" variant="ghost" icon={X} onClick={() => setSelected([])}>{s.table.selection.clear}</Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
