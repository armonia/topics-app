/**
 * n14 live: every deadline of every case the person can see, plus the ones
 * nobody's case writes, as a table and as a month. The filters, the month and
 * the day are kept in the container; a deadline can be marked as handled, and
 * the schedule can be exported as an iCalendar file.
 */
import { CalendarCheck, Download } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../../../components/Shared/Segmented';
import { Button } from '../../../../ui/primitives/Button';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { TablesNav } from '../../../../ui/data/TablesNav';
import { DeadlinesView } from '../../../../ui/data/DeadlinesView';
import type { CalendarItemModel, DeadlineDetailModel, DeadlineRowModel } from '../../../../ui/data/model';
import { DEMO_TODAY, daysFromToday, formatDay, formatShortDay } from '../../../../ui/fixtures/org/clock';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { DEADLINES_TABLE, DECLARED_TOTALS, VIEW_SEEDS, type ViewSeed } from '../../../../ui/fixtures/data';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import { allDeadlines, officesOf, toIcs, type DeadlineItem, type DeadlineStatus } from './deadlines';
import { buildRows, downloadText, type AddedRow } from './engine';
import type { QuarantineDecisions } from './quality';
import { dataLinks, tableNavItems, viewNavItems } from './nav';

type View = 'table' | 'calendar';

const TONE: Record<DeadlineStatus, 'green' | 'red' | 'amber' | 'neutral'> = { done: 'green', overdue: 'red', soon: 'amber', open: 'neutral', scheduled: 'neutral' };

/** `04/01` in the year of the demo, `04/01/2027` in another. */
const dayText = (day: string) => (day.startsWith(DEMO_TODAY.slice(0, 4)) ? formatShortDay(day) : formatDay(day));

export function DeadlinesScreen({ ctx }: { ctx: ScreenCtx }) {
  const d = ctx.copy.dataMore;
  const t = d.deadlines;
  const [view, setView] = ctx.ui<View>('dm.dl.view', 'table');
  const [q, setQ] = ctx.ui<string>('dm.dl.q', '');
  const [office, setOffice] = ctx.ui<string>('dm.dl.office', '');
  const [showDone, setShowDone] = ctx.ui<boolean>('dm.dl.done', false);
  const [month, setMonth] = ctx.ui<string>('dm.dl.month', DEMO_TODAY.slice(0, 7));
  const [day, setDay] = ctx.ui<string>('dm.dl.day', DEMO_TODAY);
  const [peekId, setPeekId] = ctx.ui<string>('dm.dl.peek', '');
  const [handled, setHandled] = ctx.slice<string[]>('deadlineDone', []);
  const [custom] = ctx.slice<ViewSeed[]>('dataViews', []);
  const [added] = ctx.slice<AddedRow[]>('dataRows', []);
  const [read] = ctx.slice<string[]>('dataRead', []);
  const [decisions] = ctx.slice<QuarantineDecisions>('quarantine', {});

  const items: DeadlineItem[] = allDeadlines(ctx.state, ctx.persona).map((i) => (handled.includes(i.id) ? { ...i, status: 'done' as const } : i));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((i) => (showDone || i.status !== 'done')
    && (!office || i.office === office)
    && words.every((w) => `${i.label} ${i.about} ${i.writer} ${OFFICE_LABEL[i.office]} ${i.rule ?? ''}`.toLowerCase().includes(w)));
  const open = items.filter((i) => i.status !== 'done');
  const counts = { overdue: open.filter((i) => i.status === 'overdue').length, soon: open.filter((i) => i.status === 'soon').length, open: open.length };

  const whenText = (i: DeadlineItem) => {
    const n = daysFromToday(i.date);
    if (i.status === 'done') return t.status.done;
    if (n < 0) return t.overdueBy(-n);
    return n === 0 ? t.todayText : t.inDays(n);
  };
  const rowOf = (i: DeadlineItem): DeadlineRowModel => ({
    id: i.id,
    dateText: dayText(i.date),
    label: i.label,
    officeLabel: OFFICE_LABEL[i.office],
    about: i.about || '·',
    writer: i.writer,
    statusText: t.status[i.status],
    statusTone: TONE[i.status],
    when: whenText(i),
    example: i.example,
  });
  const rows = shown.map(rowOf);
  const dayRows = shown.filter((i) => i.date === day).map(rowOf);
  const calendarItems: CalendarItemModel[] = shown.map((i) => ({ id: i.id, day: i.date, label: i.label, tone: i.status === 'overdue' ? 'red' : i.status === 'soon' ? 'amber' : i.status === 'done' ? 'green' : i.status === 'scheduled' ? 'neutral' : 'blue', opens: true }));

  const openItem = (id: string) => {
    const i = items.find((x) => x.id === id);
    if (!i) return;
    if (i.caseId) ctx.go(P.recordSheet(i.caseId));
    else setPeekId(id);
  };

  const peekItem = items.find((i) => i.id === peekId) ?? items.find((i) => !i.caseId);
  const detail: DeadlineDetailModel | undefined = peekItem && {
    id: peekItem.id,
    title: peekItem.label,
    statusText: t.status[peekItem.status],
    statusTone: TONE[peekItem.status],
    hasCase: Boolean(peekItem.caseId),
    done: peekItem.status === 'done',
    fields: [
      { label: t.detail.date, value: `${formatDay(peekItem.date)} · ${whenText(peekItem)}`, tone: peekItem.status === 'overdue' ? 'red' : undefined },
      { label: t.detail.office, value: OFFICE_LABEL[peekItem.office] },
      ...(peekItem.about ? [{ label: t.detail.about, value: peekItem.about }] : []),
      { label: t.detail.writer, value: peekItem.writer },
      ...(peekItem.rule ? [{ label: t.detail.rule, value: peekItem.rule }] : []),
      ...(peekItem.calc ? [{ label: t.detail.calc, value: peekItem.calc }] : []),
      ...(peekItem.note ? [{ label: t.detail.note, value: peekItem.note }] : []),
      { label: t.detail.whoEdits, value: t.detail.whoEditsValue },
    ],
    history: [
      { text: t.detail.writtenBy(peekItem.writer), when: peekItem.caseId ? formatDay((caseSeed(peekItem.caseId)?.arrivedAt ?? '').slice(0, 10) || DEMO_TODAY) : d.common.example },
      ...(handled.includes(peekItem.id) ? [{ text: t.detail.handledBy(ctx.persona.name), when: formatDay(DEMO_TODAY) }] : []),
    ],
  };
  const toggleHandled = () => {
    if (!peekItem) return;
    const on = !handled.includes(peekItem.id);
    setHandled((prev) => (on ? [...prev, peekItem.id] : prev.filter((x) => x !== peekItem.id)));
    ctx.log(on ? d.log.deadlineHandled(peekItem.label) : d.log.deadlineReopened(peekItem.label), 'case', P.deadlines());
    ctx.toast({ tone: 'ok', title: on ? t.toast.handled(peekItem.label) : t.toast.reopened(peekItem.label) });
  };

  const exportIcs = () => {
    downloadText(`scadenzario-${DEMO_TODAY}.ics`, toIcs(shown, d.format.product), 'text/calendar');
    ctx.log(d.log.deadlinesExported(shown.length), 'share', P.deadlines());
    ctx.toast({ tone: 'ok', title: t.toast.exported(shown.length), body: `scadenzario-${DEMO_TODAY}.ics` });
  };

  const rowsFor = (table: string) => buildRows(table, ctx.state, ctx.persona, added, read, decisions);
  const controls = (
    <>
      <SegmentedControl value={view} onChange={setView} ariaLabel={t.viewsLabel} options={[{ value: 'table', label: ctx.copy.data.views.table }, { value: 'calendar', label: ctx.copy.data.views.calendar }]} />
      <Button icon={Download} onClick={ctx.allow('export', exportIcs)} title={ctx.deniedTitle('export')}>{t.exportIcs}</Button>
    </>
  );
  const peekActions = peekItem && (
    <>
      {peekItem.caseId && <Button variant="primary" onClick={() => ctx.go(P.recordSheet(peekItem.caseId as string))}>{t.detail.openSheet}</Button>}
      {peekItem.caseId && <Button onClick={() => ctx.go(P.record(peekItem.caseId as string))}>{t.detail.openCase}</Button>}
      <Button icon={CalendarCheck} onClick={ctx.allow('edit:data', toggleHandled)} title={ctx.deniedTitle('edit:data')}>{handled.includes(peekItem.id) ? t.detail.reopen : t.detail.markHandled}</Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: ctx.copy.data.root }, { label: DEADLINES_TABLE.label }]}>{!ctx.phone && controls}</PaneHeader>
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">{controls}</div>}
      <div className={clsx('flex min-h-0 flex-1', ctx.phone && 'flex-col overflow-y-auto')}>
        <TablesNav
          tables={tableNavItems(ctx, rowsFor)}
          selectedTableId={DEADLINES_TABLE.id}
          onSelectTable={(id) => ctx.go(id === DEADLINES_TABLE.id ? P.deadlines() : id === 'pratiche' ? P.data() : P.data(id))}
          views={viewNavItems(ctx, [...VIEW_SEEDS, ...custom], rowsFor)}
          onSelectView={(id) => ctx.go(P.dataView(id))}
          removableViewIds={[]}
          links={dataLinks(ctx)}
          onLink={(id) => ctx.go(id === 'schema' ? P.dataSchema() : P.quality())}
          copy={ctx.copy}
          phone={ctx.phone}
        />
        <DeadlinesView
          copy={ctx.copy}
          phone={ctx.phone}
          view={view}
          query={q}
          onQuery={setQ}
          office={office}
          offices={officesOf(items)}
          onOffice={setOffice}
          showDone={showDone}
          onShowDone={setShowDone}
          rows={view === 'table' ? rows : dayRows}
          counts={counts}
          openTotal={new Intl.NumberFormat(ctx.copy.dataMore.format.locale).format(DECLARED_TOTALS.scadenze)}
          writers={new Set(items.map((i) => i.writer)).size}
          month={month}
          today={DEMO_TODAY}
          items={calendarItems}
          selectedDay={day}
          onDay={setDay}
          onMonth={(delta) => {
            if (delta === 0) { setMonth(DEMO_TODAY.slice(0, 7)); setDay(DEMO_TODAY); return; }
            const [y, m] = month.split('-').map(Number);
            const next = new Date(Date.UTC(y, m - 1 + delta, 1));
            setMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`);
          }}
          onOpenRow={openItem}
          onPeekRow={setPeekId}
          activeId={peekItem?.id}
          detail={detail}
          detailActions={peekActions}
          dayLabel={formatDay(day)}
        />
      </div>
    </div>
  );
}
