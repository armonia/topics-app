/**
 * x01 live: the tables of the organization. Filters, search, saved views,
 * sorting, grouping, selection and the side panel all keep their state in the
 * container (`ctx.ui`), so a reload lands where the reader left; the rows
 * come from the example cases with what the reader changed on them.
 */
import { useState } from 'react';
import { Database, FileSearch, ListChecks, Plus } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../../../components/Shared/Segmented';
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Select, TextField } from '../../../../ui/primitives/Field';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { TableGrid } from '../../../../ui/data/TableGrid';
import { TablesNav, type NavLinkModel } from '../../../../ui/data/TablesNav';
import { FilterBar } from '../../../../ui/data/FilterBar';
import { SelectionToolbar } from '../../../../ui/data/SelectionToolbar';
import { RowPeek } from '../../../../ui/data/RowPeek';
import { StatusBoard } from '../../../../ui/data/StatusBoard';
import { GroupChart } from '../../../../ui/data/GroupChart';
import { MonthCalendar } from '../../../../ui/data/MonthCalendar';
import type { DataView, FilterColumnModel } from '../../../../ui/data/model';
import { DEMO_TODAY, formatDay } from '../../../../ui/fixtures/org/clock';
import { OFFICE_LABEL, PERSONAS } from '../../../../ui/fixtures/org/people';
import type { CaseKind, Office } from '../../../../ui/fixtures/org/types';
import {
  DEADLINES_TABLE, DEFAULT_OFFICE, KIND_TYPE, NEW_CASE_LABEL, PROGRAM_OF_HOME, ROW_OFFICES, TABLE_COLUMNS, VIEW_SEEDS, type ViewSeed,
} from '../../../../ui/fixtures/data';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { allDeadlines } from './deadlines';
import {
  applyView, buildRows, downloadText, isCaseTable, sortRows, groupRows, toCsv, type AddedRow, type Filter, type Sort,
} from './engine';
import type { QuarantineDecisions } from './quality';
import { barsOf, boardOf, cellText, columnLabel, filterColumns, gridModelOf, groupColumns, peekOf, tableMeta, valueLabel } from './rows';
import { dataLinks, tableNavItems, viewNavItems } from './nav';

const WITHIN_OPTIONS = ['7', '30', '60', '90'];

/** What a table starts as: no filters, grouped by type for the cases, the nearest deadline first. */
function defaults(table: string): Omit<ViewSeed, 'id' | 'label' | 'table'> {
  if (isCaseTable(table)) return { filters: [], group: table === 'pratiche' ? 'tipo' : '', sort: { col: 'scadenza', dir: 'asc' } };
  return { filters: [], group: '', sort: { col: 'nome', dir: 'asc' } };  // allow-italian: id of the fixture data, not shown
}

export function TableScreen({ ctx, table, viewId }: { ctx: ScreenCtx; table: string; viewId?: string }) {
  const d = ctx.copy.dataMore;
  const [custom, setCustom] = ctx.slice<ViewSeed[]>('dataViews', []);
  const views = [...VIEW_SEEDS, ...custom];
  const seed = viewId ? views.find((v) => v.id === viewId) : undefined;
  const t = seed?.table ?? table;
  const meta = tableMeta(t);
  const k = viewId ? `v.${viewId}` : `t.${t}`;
  const base = seed ?? { ...defaults(t) };
  const [filters, setFilters] = ctx.ui<Filter[]>(`dm.${k}.filters`, base.filters ?? []);
  const [q, setQ] = ctx.ui<string>(`dm.${k}.q`, base.q ?? '');
  const [group, setGroup] = ctx.ui<string>(`dm.${k}.group`, base.group ?? '');
  const [sort, setSort] = ctx.ui<Sort | null>(`dm.${k}.sort`, base.sort ?? null);
  const [rule, setRule] = ctx.ui<ViewSeed['rule'] | null>(`dm.${k}.rule`, base.rule ?? null);
  const [view, setView] = ctx.ui<DataView>(`dm.${k}.view`, 'table');
  const [selected, setSelected] = ctx.ui<string[]>(`dm.${k}.selected`, []);
  const [peekId, setPeekId] = ctx.ui<string>(`dm.${k}.peek`, '');
  const [chartBy, setChartBy] = ctx.ui<string>(`dm.${k}.chartBy`, groupColumns(t)[0]);
  const [month, setMonth] = ctx.ui<string>(`dm.${k}.month`, DEMO_TODAY.slice(0, 7));
  const [day, setDay] = ctx.ui<string>(`dm.${k}.day`, '');
  const [added, setAdded] = ctx.slice<AddedRow[]>('dataRows', []);
  const [read, setRead] = ctx.slice<string[]>('dataRead', []);
  const [decisions] = ctx.slice<QuarantineDecisions>('quarantine', {});
  const [dialog, setDialog] = useState<'new' | 'save' | null>(null);
  const [draft, setDraft] = useState<{ title: string; kind: CaseKind; office: Office; name: string; tried: boolean }>({ title: '', kind: 'ricorso', office: 'legale', name: '', tried: false });

  if (!meta) {
    return (
      <EmptyState icon={Database} title={d.notFound.title} action={<Button variant="primary" onClick={() => ctx.go(P.data())}>{d.notFound.back}</Button>}>
        {d.notFound.body}
      </EmptyState>
    );
  }

  const caseTable = isCaseTable(t);
  const allRows = buildRows(t, ctx.state, ctx.persona, added, read, decisions);
  const shown = sortRows(applyView(allRows, filters, q, rule ?? undefined, ctx.persona), sort);
  const groups = groupRows(shown, group || null);
  const grid = gridModelOf(t, groups, group || null, d.grid.addedNow, d.grid.groupCount);
  const rowsById = new Map(allRows.map((r) => [r.id, r]));
  const peekRow = rowsById.get(peekId) ?? shown[0];
  const peek = peekRow ? peekOf(t, peekRow, ctx.state, ctx.copy) : undefined;
  const available: DataView[] = caseTable ? ['table', 'byStatus', 'calendar', 'chart'] : ['table', 'chart'];
  const activeView: DataView = available.includes(view) ? view : 'table';
  const selectedShown = selected.filter((id) => shown.some((r) => r.id === id));
  const total = meta.total ?? allRows.length;
  const tick = (ids: string[]) => setSelected(ids);

  const programPath = (programId: string) => P.program(programId);
  const openRow = (id: string) => {
    const r = rowsById.get(id);
    if (!r?.caseId) { setPeekId(id); return; }
    setRead((prev) => (prev.includes(id) ? prev : [...prev, id]));
    ctx.go(P.record(r.caseId));
  };
  const peekRowId = (id: string) => { setPeekId(id); if (activeView !== 'table') setView('table'); };
  const openCell = (rowId: string, col: string) => {
    if (col === 'protocollo') ctx.go(programPath('halley'));
    else if (col === 'contribuente' || col === 'codice') ctx.go(programPath(PROGRAM_OF_HOME.prunes));
    else if (col === 'programma') ctx.go(programPath(PROGRAM_OF_HOME.teamsystem));
    else openRow(rowId);
  };

  /* ---- filters ---- */
  const chipText = (f: Filter) => (f.op === 'within'
    ? `${columnLabel(t, f.col)} ${d.toolbar.within(Number(f.value))}`
    : `${columnLabel(t, f.col)} ${f.op === 'is' ? '=' : '≠'} ${valueLabel(f.col, f.value)}`);
  const chips = [
    ...filters.map((f, i) => ({ id: `f${i}`, text: chipText(f) })),
    ...(rule ? [{ id: 'rule', text: d.toolbar.rule[rule] }] : []),
  ];
  const columns: FilterColumnModel[] = filterColumns(t).map((c) => (c === 'scadenza'
    ? { id: c, label: columnLabel(t, c), kind: 'within' as const, options: WITHIN_OPTIONS.map((n) => ({ value: n, label: d.toolbar.withinOption(Number(n)) })) }
    : {
      id: c, label: columnLabel(t, c), kind: 'select' as const,
      options: [...new Set(allRows.map((r) => String(r.values[c] ?? '')).filter(Boolean))].sort().map((v) => ({ value: v, label: valueLabel(c, v) })),
    }));
  const removeChip = (id: string) => {
    if (id === 'rule') setRule(null);
    else setFilters((prev) => prev.filter((_, i) => `f${i}` !== id));
  };
  const sortLabel = sort ? d.toolbar.sortChip(columnLabel(t, sort.col), sort.dir) : d.toolbar.noSort;
  const sortColumn = (col: string) => setSort((prev) => (prev?.col === col ? (prev.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' }));
  const sortItems = [
    ...(TABLE_COLUMNS[t] ?? []).filter((c) => c.sortable).map((c) => ({ id: c.id, label: c.label, hint: sort?.col === c.id ? d.toolbar.dir[sort.dir] : undefined })),
    { id: '-', label: '', separator: true },
    { id: '', label: d.toolbar.noSort, disabled: !sort },
  ];
  const sameAsBase = JSON.stringify({ filters, q, group, sort, rule }) === JSON.stringify({ filters: base.filters ?? [], q: base.q ?? '', group: base.group ?? '', sort: base.sort ?? null, rule: base.rule ?? null });
  const reset = () => { setFilters(base.filters ?? []); setQ(base.q ?? ''); setGroup(base.group ?? ''); setSort(base.sort ?? null); setRule(base.rule ?? null); };

  /* ---- actions ---- */
  const exportRows = (ids?: string[]) => {
    const cols = TABLE_COLUMNS[t] ?? [];
    const rowsOut = grid.groups.flatMap((g) => g.rows).filter((r) => !ids || ids.includes(r.id));
    const csv = toCsv(cols.map((c) => c.label), rowsOut.map((r) => cols.map((c) => cellText(r.cells[c.id] ?? { kind: 'empty' }))));
    const name = `${t}-${DEMO_TODAY}.csv`;
    downloadText(name, csv, 'text/csv');
    ctx.log(d.log.exported(rowsOut.length, meta.label), 'share', P.data(t === 'pratiche' ? undefined : t));
    ctx.toast({ tone: 'ok', title: d.toast.exported(rowsOut.length), body: name });
  };
  const assignItems = !caseTable ? null : ctx.can('edit:data')
    ? PERSONAS.filter((p) => p.orgs.includes('nocera')).map((p) => ({ id: p.id, label: p.name }))
    : false;
  const assign = (personId: string) => {
    const person = PERSONAS.find((p) => p.id === personId);
    if (!person) return;
    const ids = selectedShown.filter((id) => rowsById.get(id)?.caseId);
    for (const id of ids) ctx.updateCase(id, (live) => ({ ...live, assignee: personId }), d.log.assigned(rowsById.get(id)?.values.oggetto as string, person.name));
    ctx.toast({ tone: 'ok', title: d.toast.assigned(ids.length, person.name) });
    tick([]);
  };
  const markRead = () => {
    setRead((prev) => [...new Set([...prev, ...selectedShown])]);
    ctx.toast({ tone: 'info', title: d.toast.markedRead(selectedShown.length) });
    tick([]);
  };

  const createRow = () => {
    if (!draft.title.trim()) { setDraft({ ...draft, tried: true }); return; }
    const row: AddedRow = { id: `new-${added.length + 1}`, title: draft.title.trim(), kind: draft.kind, office: draft.office, by: ctx.persona.id, at: ctx.now };
    setAdded((prev) => [row, ...prev]);
    setPeekId(row.id);
    setView('table');
    ctx.log(d.log.rowAdded(row.title), 'case', P.data());
    ctx.toast({ tone: 'ok', title: d.toast.rowAdded(row.title) });
    setDialog(null);
  };
  const saveView = () => {
    const label = draft.name.trim();
    if (!label) { setDraft({ ...draft, tried: true }); return; }
    const next: ViewSeed = { id: `u-${custom.length + 1}`, label, table: t, filters, q, group, sort: sort ?? undefined, rule: rule ?? undefined };
    setCustom((prev) => [...prev, next]);
    ctx.log(d.log.viewSaved(label, meta.label), 'structure', P.dataView(next.id));
    ctx.toast({ tone: 'ok', title: d.toast.viewSaved(label) });
    setDialog(null);
    ctx.go(P.dataView(next.id));
  };
  const removeView = (id: string) => {
    const v = custom.find((x) => x.id === id);
    if (!v) return;
    ctx.confirm({
      title: d.removeView.title(v.label),
      body: d.removeView.body,
      confirmLabel: d.removeView.confirm,
      tone: 'danger',
      onConfirm: () => {
        setCustom((prev) => prev.filter((x) => x.id !== id));
        ctx.log(d.log.viewRemoved(v.label), 'structure');
        ctx.toast({ tone: 'info', title: d.toast.viewRemoved(v.label) });
        if (viewId === id) ctx.go(P.data(v.table === 'pratiche' ? undefined : v.table));
      },
    });
  };

  /* ---- the places around ---- */
  const rowsFor = (table: string) => buildRows(table, ctx.state, ctx.persona, added, read, decisions);
  const nav = tableNavItems(ctx, rowsFor);
  const links: NavLinkModel[] = dataLinks(ctx);
  const goNav = (id: string) => {
    if (id === DEADLINES_TABLE.id) ctx.go(P.deadlines());
    else ctx.go(id === 'pratiche' ? P.data() : P.data(id));
  };
  const goLink = (id: string) => ctx.go(id === 'schema' ? P.dataSchema() : P.quality());

  /* ---- the views ---- */
  const calendarItems = (() => {
    const ids = new Set(shown.map((r) => r.caseId).filter(Boolean));
    return allDeadlines(ctx.state, ctx.persona).filter((x) => x.caseId && ids.has(x.caseId)).map((x) => ({
      id: x.id, day: x.date, label: x.label, tone: x.status === 'overdue' ? 'red' as const : x.status === 'soon' ? 'amber' as const : 'blue' as const, opens: true,
    }));
  })();
  const dayItems = calendarItems.filter((i) => i.day === day);
  const body = shown.length === 0 && (filters.length > 0 || q || rule) ? (
    <EmptyState icon={FileSearch} title={d.empty.title} action={<Button variant="primary" onClick={() => { setFilters([]); setQ(''); setRule(null); }}>{d.empty.clear}</Button>}>{d.empty.body}</EmptyState>
  ) : shown.length === 0 ? (
    <EmptyState icon={Database} title={d.empty.noRows} />
  ) : activeView === 'table' ? (
    <TableGrid
      model={grid}
      copy={ctx.copy}
      sort={sort}
      onSort={sortColumn}
      selectedIds={selectedShown}
      onToggleRow={(id) => tick(selectedShown.includes(id) ? selectedShown.filter((x) => x !== id) : [...selectedShown, id])}
      onToggleAll={() => tick(selectedShown.length === shown.length ? [] : shown.map((r) => r.id))}
      activeId={peekRow?.id}
      onOpenRow={openRow}
      onPeekRow={setPeekId}
      onOpenCell={openCell}
    />
  ) : activeView === 'byStatus' ? (
    <StatusBoard columns={boardOf(t, shown)} copy={ctx.copy} onOpen={(id) => (rowsById.get(id)?.caseId ? openRow(id) : peekRowId(id))} />
  ) : activeView === 'chart' ? (
    <div className="space-y-3">
      <SegmentedControl
        ariaLabel={d.chart.by}
        value={groupColumns(t).includes(chartBy) ? chartBy : groupColumns(t)[0]}
        onChange={setChartBy}
        options={groupColumns(t).map((c) => ({ value: c, label: columnLabel(t, c) }))}
      />
      <GroupChart
        bars={barsOf(shown, groupColumns(t).includes(chartBy) ? chartBy : groupColumns(t)[0])}
        copy={ctx.copy}
        onBar={(id) => {
          const col = groupColumns(t).includes(chartBy) ? chartBy : groupColumns(t)[0];
          setFilters((prev) => [...prev.filter((f) => f.col !== col), { col, op: 'is', value: id }]);
          setView('table');
        }}
      />
    </div>
  ) : (
    <div className="space-y-3">
      <MonthCalendar
        month={month}
        today={DEMO_TODAY}
        items={calendarItems}
        selectedDay={day || undefined}
        onDay={setDay}
        onItem={(id) => { const dl = calendarItems.find((i) => i.id === id); const caseId = id.split(':')[0]; if (dl) ctx.go(P.recordSheet(caseId)); }}
        onMonth={(delta) => {
          if (delta === 0) { setMonth(DEMO_TODAY.slice(0, 7)); setDay(DEMO_TODAY); return; }
          const [y, m] = month.split('-').map(Number);
          const next = new Date(Date.UTC(y, m - 1 + delta, 1));
          setMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`);
        }}
        copy={ctx.copy}
        phone={ctx.phone}
      />
      {day && (
        <div className="rounded-lg border border-app-border bg-surface px-3.5 py-3 text-prose">
          <p className="mb-1 font-semibold text-app-text">{formatDay(day)}</p>
          {dayItems.length === 0 ? <p className="text-app-text-secondary">{d.calendar.nothing}</p> : dayItems.map((i) => (
            <button key={i.id} type="button" onClick={() => ctx.go(P.recordSheet(i.id.split(':')[0]))} className="block w-full truncate rounded px-1 py-1 text-left text-app-text hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );

  const controls = (
    <>
      <SegmentedControl
        value={activeView}
        onChange={setView}
        ariaLabel={d.toolbar.viewsLabel}
        options={available.map((v) => ({ value: v, label: ctx.copy.data.views[v] }))}
      />
      <Button onClick={ctx.allow('export', () => exportRows())} title={ctx.deniedTitle('export')}>{d.toolbar.exportExcel}</Button>
      <Button icon={ListChecks} onClick={() => ctx.go(P.dataFields(t))}>{d.toolbar.fields}</Button>
      {caseTable && <Button variant="primary" icon={Plus} onClick={ctx.allow('edit:data', () => { setDraft({ title: '', kind: 'ricorso', office: 'legale', name: '', tried: false }); setDialog('new'); })} title={ctx.deniedTitle('edit:data')}>{NEW_CASE_LABEL}</Button>}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: ctx.copy.data.root }, { label: seed?.label ?? meta.label, detail: seed ? undefined : (meta.total ? d.footer.headerCount(shown.length, new Intl.NumberFormat(d.format.locale).format(total)) : new Intl.NumberFormat(d.format.locale).format(total)) }]}>
        {!ctx.phone && controls}
      </PaneHeader>
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">{controls}</div>}
      <div className={clsx('flex min-h-0 flex-1', ctx.phone && 'flex-col overflow-y-auto')}>
        <TablesNav
          tables={nav}
          selectedTableId={t}
          onSelectTable={goNav}
          views={viewNavItems(ctx, views, rowsFor)}
          selectedViewId={viewId}
          onSelectView={(id) => ctx.go(P.dataView(id))}
          onRemoveView={removeView}
          removableViewIds={custom.map((v) => v.id)}
          links={links}
          onLink={goLink}
          copy={ctx.copy}
          phone={ctx.phone}
        />
        <section className={clsx('min-w-0 flex-1 px-4 py-4 max-sm:px-3', !ctx.phone && 'overflow-y-auto')}>
          <FilterBar
            copy={ctx.copy}
            chips={chips}
            onRemove={removeChip}
            columns={columns}
            onAdd={(f) => setFilters((prev) => [...prev, f])}
            group={group}
            groupOptions={[{ id: '', label: d.toolbar.noGroup }, ...groupColumns(t).map((c) => ({ id: c, label: columnLabel(t, c) }))]}
            onGroup={setGroup}
            sortText={sortLabel}
            sortItems={sortItems}
            onSort={(id) => (id ? sortColumn(id) : setSort(null))}
            q={q}
            onQuery={setQ}
            onSave={ctx.allow('edit:structure', () => { setDraft({ ...draft, name: '', tried: false }); setDialog('save'); })}
            saveDenied={ctx.deniedTitle('edit:structure')}
            onReset={sameAsBase ? undefined : reset}
          />
          {body}
          {selectedShown.length > 0 && activeView === 'table' && (
            <div className="mt-3">
              <SelectionToolbar
                count={selectedShown.length}
                copy={ctx.copy}
                assignItems={assignItems}
                onAssign={assign}
                onExport={ctx.allow('export', () => exportRows(selectedShown))}
                onMarkRead={markRead}
                onClear={() => tick([])}
                assignDenied={ctx.deniedTitle('edit:data')}
                exportDenied={ctx.deniedTitle('export')}
              />
            </div>
          )}
          <p className="mt-3 text-compact text-app-text-tertiary">
            {meta.total ? d.footer.shownOf(shown.length, new Intl.NumberFormat(d.format.locale).format(meta.total)) : d.footer.shown(shown.length)}
            {' · '}{caseTable ? d.footer.links(Object.values({ prunes: 'Prunes', halley: 'Halley' })) : meta.summary}
          </p>
        </section>
        {peek && activeView === 'table' && (
          <RowPeek
            row={peek}
            copy={ctx.copy}
            phone={ctx.phone}
            onOpen={peekRow?.caseId ? () => openRow(peekRow.id) : undefined}
            onOpenLinked={(id) => {
              if (id.startsWith('case:')) ctx.go(P.record(id.slice(5)));
              else if (id === 'quarantine') ctx.go(P.qualityItem('q-iban'));
              else if (id === 'counterpart') ctx.go(P.program('prunes'));
              else if (peekRow?.caseId) ctx.go(P.record(peekRow.caseId));
            }}
          />
        )}
      </div>
      {dialog === 'new' && (
        <Dialog
          title={d.newRow.title}
          closeLabel={ctx.copy.common.close}
          onClose={() => setDialog(null)}
          footer={<><Button onClick={() => setDialog(null)}>{d.common.cancel}</Button><Button variant="primary" onClick={createRow}>{d.newRow.create}</Button></>}
        >
          <div className="space-y-3">
            <TextField autoFocus label={d.newRow.subject} value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} onEnter={createRow} error={draft.tried && !draft.title.trim() ? d.newRow.subjectRequired : undefined} hint={d.newRow.subjectHint} />
            <Select label={d.newRow.type} value={draft.kind} options={(Object.keys(KIND_TYPE) as CaseKind[]).map((kd) => ({ value: kd, label: `${KIND_TYPE[kd]?.letter} · ${KIND_TYPE[kd]?.label}` }))} onChange={(v) => setDraft({ ...draft, kind: v as CaseKind, office: DEFAULT_OFFICE[v as CaseKind] ?? draft.office })} />
            <Select label={d.newRow.office} value={draft.office} options={ROW_OFFICES.map((o) => ({ value: o, label: OFFICE_LABEL[o] }))} onChange={(v) => setDraft({ ...draft, office: v as Office })} />
          </div>
        </Dialog>
      )}
      {dialog === 'save' && (
        <Dialog
          title={d.saveView.title}
          closeLabel={ctx.copy.common.close}
          size="sm"
          onClose={() => setDialog(null)}
          footer={<><Button onClick={() => setDialog(null)}>{d.common.cancel}</Button><Button variant="primary" onClick={saveView}>{d.saveView.save}</Button></>}
        >
          <TextField autoFocus label={d.saveView.name} value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} onEnter={saveView} error={draft.tried && !draft.name.trim() ? d.saveView.nameRequired : undefined} hint={d.saveView.hint(chips.length)} />
        </Dialog>
      )}
    </div>
  );
}
