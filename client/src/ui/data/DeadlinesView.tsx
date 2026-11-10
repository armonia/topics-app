import type { ReactNode } from 'react';
import { PanelRight, Search } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card, StatCard } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Checkbox, Select, TextField } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { Table, type TableRowModel } from '../primitives/Table';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import type { CalendarItemModel, DeadlineDetailModel, DeadlineRowModel } from './model';
import { MonthCalendar } from './MonthCalendar';

/**
 * The schedule of deadlines (n14), the same list as a table and as a month.
 * Everything the reader sets here (the office, the search, the month, the day
 * picked) comes in as props and goes out as events, so it survives a reload
 * in the container.
 */
export function DeadlinesView({
  copy, phone, view, query, onQuery, office, offices, onOffice, showDone, onShowDone, rows, counts, openTotal, writers,
  month, today, items, selectedDay, onDay, onMonth, onOpenRow, onPeekRow, activeId, detail, detailActions, onClearDay, dayLabel,
}: {
  copy: UiCopy;
  phone: boolean;
  view: 'table' | 'calendar';
  query: string;
  onQuery: (q: string) => void;
  office: string;
  offices: Array<{ value: string; label: string }>;
  onOffice: (o: string) => void;
  showDone: boolean;
  onShowDone: (v: boolean) => void;
  rows: DeadlineRowModel[];
  counts: { overdue: number; soon: number; open: number };
  /** Open deadlines in the whole organization when declared; the counts above are the example rows. */
  openTotal?: string;
  /** How many flows write to this table. */
  writers: number;
  month: string;
  today: string;
  items: CalendarItemModel[];
  selectedDay?: string;
  onDay: (day: string) => void;
  onMonth: (delta: -1 | 0 | 1) => void;
  onOpenRow: (id: string) => void;
  onPeekRow: (id: string) => void;
  activeId?: string;
  detail?: DeadlineDetailModel;
  /** The buttons of the panel, built by the caller (they navigate and change state). */
  detailActions?: ReactNode;
  onClearDay?: () => void;
  dayLabel?: string;
}) {
  const t = copy.dataMore.deadlines;
  const tableRows: TableRowModel[] = rows.map((r) => ({
    id: r.id,
    selected: r.id === activeId,
    onOpen: () => onOpenRow(r.id),
    muted: r.statusText === t.status.done,
    cells: {
      date: <span className={clsx('font-semibold tabular-nums', r.statusTone === 'red' && TONE_TEXT.red)}>{r.dateText}</span>,
      label: (
        <span className="flex min-w-0 flex-col leading-4">
          <span className="flex items-center gap-1.5"><span className="min-w-0">{r.label}</span>{r.example && <Chip>{copy.dataMore.common.example}</Chip>}</span>
          <span className={clsx('text-mini', r.statusTone === 'red' ? TONE_TEXT.red : 'text-app-text-tertiary')}>{r.when}</span>
        </span>
      ),
      office: r.officeLabel,
      about: <span className="block text-compact leading-4">{r.about}</span>,
      writer: <span className="block text-compact leading-4 text-app-text-secondary">{r.writer}</span>,
      status: <Chip tone={r.statusTone}>{r.statusText}</Chip>,
      peek: (
        <button
          type="button"
          aria-label={t.peek}
          data-tip={t.peek}
          aria-pressed={r.id === activeId}
          onClick={(e) => { e.stopPropagation(); onPeekRow(r.id); }}
          onKeyDown={(e) => e.stopPropagation()}
          className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors', r.id === activeId ? 'bg-black/[0.07] text-app-text dark:bg-white/[0.12]' : 'text-app-text-tertiary hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING)}
        >
          <PanelRight size={14} aria-hidden="true" />
        </button>
      ),
    },
  }));
  const narrow = Boolean(detail) && !phone;
  const main = (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-title font-semibold text-app-text">{t.title}</h2>
        <Chip>{t.usedBy(writers)}</Chip>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
        <StatCard label={t.stats.overdue} value={counts.overdue} tone={counts.overdue ? 'red' : undefined} />
        <StatCard label={t.stats.soon} value={counts.soon} tone={counts.soon ? 'amber' : undefined} />
        <StatCard label={t.stats.open} value={counts.open} detail={openTotal ? t.stats.openDetail(openTotal) : undefined} />
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1 sm:max-w-[320px]">
          <TextField type="search" icon={Search} value={query} onChange={onQuery} placeholder={t.search} title={t.searchLabel} />
        </div>
        <div className="min-w-[180px]">
          <Select title={t.office} value={office} options={[{ value: '', label: t.allOffices }, ...offices]} onChange={onOffice} />
        </div>
        <Checkbox checked={showDone} onChange={onShowDone} label={t.showDone} />
      </div>
      {view === 'table' ? (
        <Table
          ariaLabel={t.title}
          columns={[
            { id: 'date', label: t.columns.date, width: 76 },
            { id: 'label', label: t.columns.what, width: 180 },
            { id: 'office', label: t.columns.office, width: 96 },
            // With the side panel open the case and the writer are read there (Riguarda, Scritta da):
            // seven columns do not fit beside it, and the status pill was the one cut off.
            ...(narrow ? [] : [
              { id: 'about', label: t.columns.case, width: 140 },
              { id: 'writer', label: t.columns.writer, width: 110 },
            ]),
            { id: 'status', label: t.columns.status, width: 112 },
            { id: 'peek', label: '', width: 44 },
          ]}
          rows={tableRows}
          empty={<EmptyState icon={Search} title={t.emptyTitle} className="min-h-0 py-6">{t.emptyBody}</EmptyState>}
        />
      ) : (
        <div className="space-y-3">
          <MonthCalendar month={month} today={today} items={items} selectedDay={selectedDay} onDay={onDay} onItem={onOpenRow} onMonth={onMonth} copy={copy} phone={phone} />
          {selectedDay && (
            <Card title={dayLabel} actions={onClearDay && <Button size="sm" variant="ghost" onClick={onClearDay}>{t.clearDay}</Button>}>
              {rows.length === 0 ? t.nothingThatDay : (
                <ul className="space-y-1">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => onOpenRow(r.id)} className={clsx('flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-prose transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}>
                        <Chip tone={r.statusTone}>{r.statusText}</Chip>
                        <span className="min-w-0 flex-1 truncate text-app-text">{r.label}</span>
                        <span className="shrink-0 text-compact text-app-text-tertiary">{r.officeLabel}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
  const side = detail && (
    <aside className={clsx('flex shrink-0 flex-col border-app-border bg-surface', phone ? 'w-full border-t' : 'h-full w-[300px] border-l')}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelHeading tag={t.detailTag} title={detail.title}><Chip tone={detail.statusTone}>{detail.statusText}</Chip></PanelHeading>
        <PanelSection>
          {detail.fields.map((f) => (
            <div key={f.label} className="flex gap-3 py-1 text-prose leading-5">
              <span className="w-24 shrink-0 text-app-text-secondary">{f.label}</span>
              <span className={clsx('min-w-0 flex-1 text-right', f.tone ? TONE_TEXT[f.tone] : 'text-app-text')}>{f.value}</span>
            </div>
          ))}
        </PanelSection>
        <PanelSection label={t.history}>
          {detail.history.map((h) => <KeyValue key={h.text} label={h.text} value={<span className="text-app-text-tertiary">{h.when}</span>} />)}
        </PanelSection>
      </div>
      {detailActions && <div className="flex shrink-0 flex-col gap-2 border-t border-app-border px-4 py-3">{detailActions}</div>}
    </aside>
  );
  return (
    <div className={clsx('flex min-h-0 min-w-0 flex-1', phone && 'flex-col overflow-y-auto')}>
      {main}
      {side}
    </div>
  );
}
