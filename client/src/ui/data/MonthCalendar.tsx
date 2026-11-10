import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button, IconButton } from '../primitives/Button';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_CHIP } from '../tone';
import type { CalendarItemModel } from './model';

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** The days of a month as weeks starting on Monday, with the days of the next and previous month that complete the rows. */
function weeks(month: string): string[][] {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(y, m - 1, 1 - offset));
  const count = Math.ceil((offset + new Date(Date.UTC(y, m, 0)).getUTCDate()) / 7);
  return Array.from({ length: count }, (_, w) => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + w * 7 + i);
    return dayOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }));
}

/**
 * A month of deadlines. Each day lists what falls on it (two at most, then
 * «+n»); a day is a button that picks it, an item opens what it names. On a
 * phone the items become dots and the day list under the calendar carries
 * the words. The month moves with the arrows, «today» comes back.
 */
export function MonthCalendar({ month, today, items, selectedDay, onDay, onItem, onMonth, copy, phone }: {
  /** `YYYY-MM` */
  month: string;
  today: string;
  items: CalendarItemModel[];
  selectedDay?: string;
  onDay: (day: string) => void;
  onItem: (id: string) => void;
  onMonth: (delta: -1 | 0 | 1) => void;
  copy: UiCopy;
  phone: boolean;
}) {
  const t = copy.dataMore.calendar;
  const [y, m] = month.split('-').map(Number);
  const byDay = new Map<string, CalendarItemModel[]>();
  for (const i of items) byDay.set(i.day, [...(byDay.get(i.day) ?? []), i]);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-body-lg font-semibold capitalize text-app-text">{t.monthTitle(copy.dataMore.months[m - 1], y)}</h3>
        {!(today.startsWith(month) && selectedDay === today) && <Button onClick={() => onMonth(0)}>{t.today}</Button>}
        <IconButton icon={ChevronLeft} label={t.previous} onClick={() => onMonth(-1)} />
        <IconButton icon={ChevronRight} label={t.next} onClick={() => onMonth(1)} />
      </div>
      <div role="grid" aria-label={t.label} className="overflow-hidden rounded-lg border border-app-border bg-surface">
        <div role="row" className="grid grid-cols-7 border-b border-app-border bg-app-inset text-center text-compact font-medium text-app-text-secondary">
          {copy.dataMore.weekdaysShort.map((w) => <span key={w} role="columnheader" className="py-1.5">{w}</span>)}
        </div>
        {weeks(month).map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7 border-b border-app-border last:border-b-0">
            {week.map((day) => {
              const inMonth = day.startsWith(month);
              const list = byDay.get(day) ?? [];
              const isToday = day === today;
              const picked = day === selectedDay;
              const shown = phone ? [] : list.slice(0, 2);
              return (
                <div key={day} role="gridcell" className={clsx('min-h-[84px] min-w-0 border-r border-app-border p-1 last:border-r-0 max-sm:min-h-[52px]', !inMonth && 'bg-black/[0.02] dark:bg-white/[0.02]')}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    aria-label={t.pickDay(Number(day.slice(8)), copy.dataMore.months[Number(day.slice(5, 7)) - 1])}
                    onClick={() => onDay(day)}
                    className={clsx(
                      'mb-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-compact tabular-nums transition-colors',
                      isToday ? 'bg-primary font-semibold text-white' : picked ? 'bg-black/[0.09] font-semibold text-app-text dark:bg-white/[0.16]' : inMonth ? 'text-app-text hover:bg-black/[0.05] dark:hover:bg-white/[0.08]' : 'text-app-text-faint hover:bg-black/[0.05]',
                      FOCUS_RING,
                    )}
                  >
                    {Number(day.slice(8))}
                  </button>
                  {phone && list.length > 0 && (
                    <span className="flex flex-wrap gap-0.5 px-0.5">
                      {list.slice(0, 3).map((i) => <span key={i.id} aria-hidden="true" className={clsx('h-1.5 w-1.5 rounded-full', TONE_CHIP[i.tone])} />)}
                    </span>
                  )}
                  {shown.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => onItem(i.id)}
                      data-tip={i.label}
                      className={clsx('mb-0.5 block w-full truncate rounded px-1 text-left text-mini leading-4 transition-colors hover:brightness-95', TONE_CHIP[i.tone], FOCUS_RING)}
                    >
                      {i.label}
                    </button>
                  ))}
                  {!phone && list.length > shown.length && (
                    <button type="button" onClick={() => onDay(day)} className={clsx('block w-full rounded px-1 text-left text-mini text-app-text-tertiary hover:text-app-text', FOCUS_RING)}>{t.more(list.length - shown.length)}</button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
