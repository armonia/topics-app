import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import { FLOAT_SURFACE, LAYER_FLOAT, focusOnMount, focusSurface } from './overlay';
import { NATIVE_LOCALE, NATIVE_TEXT, type ControlLanguage } from './nativeText';
import { placeFloat, isCoarse, type FloatBox } from './placement';

/*
 * A date field drawn by the layer: the date written dd/mm/yyyy in a box, a
 * calendar under it. The value is always `YYYY-MM-DD` (or empty), the same
 * string an `<input type="date">` would carry, so a form does not change.
 * `TextField type="date"` renders this; nothing in the layer reaches the
 * browser's own picker.
 */

/** A calendar day: month is 0 to 11 as in `Date`. */
interface Day {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const keyOf = ({ y, m, d }: Day) => `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}`;
const shown = ({ y, m, d }: Day) => `${pad(d)}/${pad(m + 1)}/${pad(y, 4)}`;

/** Reads `YYYY-MM-DD`; anything else, or a day that does not exist, is no date. */
function parse(value: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
  const probe = new Date(day.y, day.m, day.d);
  return probe.getFullYear() === day.y && probe.getMonth() === day.m && probe.getDate() === day.d ? day : null;
}

const toDay = (date: Date): Day => ({ y: date.getFullYear(), m: date.getMonth(), d: date.getDate() });
const fromDay = ({ y, m, d }: Day) => new Date(y, m, d);

/** `Date` rolls over by itself, so adding days or months is one line. */
function shift(day: Day, by: { days?: number; months?: number }): Day {
  if (by.months) {
    const total = day.y * 12 + day.m + by.months;
    const y = Math.floor(total / 12);
    const m = total - y * 12;
    // Keep the day of the month, clamped: 31 January plus a month is 28 February.
    const last = new Date(y, m + 1, 0).getDate();
    return { y, m, d: Math.min(day.d, last) };
  }
  return toDay(new Date(day.y, day.m, day.d + (by.days ?? 0)));
}

const same = (a: Day, b: Day) => a.y === b.y && a.m === b.m && a.d === b.d;

/** Monday is the first column. */
const weekdayIndex = (day: Day) => (fromDay(day).getDay() + 6) % 7;

/** The six rows of seven days that show a month, the neighbours' days included. */
function gridOf(shownMonth: Day): Day[] {
  const first = { y: shownMonth.y, m: shownMonth.m, d: 1 };
  const start = shift(first, { days: -weekdayIndex(first) });
  return Array.from({ length: 42 }, (_, i) => shift(start, { days: i }));
}

const CELL = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-compact tabular-nums transition-colors coarse:h-10 coarse:w-10 coarse:text-body-lg';
const NAV = clsx(
  'inline-flex h-7 w-7 items-center justify-center rounded-lg text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text coarse:h-10 coarse:w-10 dark:hover:bg-white/[0.08]',
  FOCUS_RING,
);
const TEXT_BUTTON = clsx(
  'inline-flex h-7 items-center rounded-lg px-2 text-compact font-medium text-primary transition-colors hover:bg-primary/10 coarse:h-10 coarse:px-3 coarse:text-body-lg',
  FOCUS_RING,
);

const CONTROL_SIZE = {
  sm: 'h-6 pl-6 pr-2 text-mini',
  md: 'h-7 pl-8 pr-2.5 text-compact',
} as const;

/**
 * The field and its calendar. Open, the calendar is a dialog: arrows move over
 * the days, Page Up and Page Down over the months (with Shift, the years),
 * Home and End to the ends of the week, Enter picks, Escape closes with the
 * focus back on the field.
 */
export function DatePicker({
  id, value, onChange, lang = 'it', placeholder, disabled, title, size = 'md', invalid, describedBy, ariaLabel, autoFocus, name,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  lang?: ControlLanguage;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
  invalid?: boolean;
  describedBy?: string;
  /** Accessible name when the field has no visible label. */
  ariaLabel?: string;
  autoFocus?: boolean;
  name?: string;
}) {
  const t = NATIVE_TEXT[lang];
  const locale = NATIVE_LOCALE[lang];
  const calendarId = useId();
  const [box, setBox] = useState<FloatBox | null>(null);
  /** The day the keyboard is on; its month is the month shown. */
  const [focus, setFocus] = useState<Day>({ y: 2000, m: 0, d: 1 });
  /** Whether the focus belongs on the day grid (it does not after a click on a month arrow). */
  const [inGrid, setInGrid] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);

  const current = parse(value);
  const today = toDay(new Date());
  const open = box !== null;

  const names = useMemo(() => {
    const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
    const long = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const short = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    // 1 January 2024 is a Monday.
    const week = Array.from({ length: 7 }, (_, i) => short.format(new Date(2024, 0, 1 + i)));
    return { month, long, week };
  }, [locale]);

  const close = () => {
    setBox(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {
    if (!trigger.current || disabled) return;
    const coarse = isCoarse(trigger.current);
    setBox(placeFloat(trigger.current, { width: coarse ? 296 : 240, height: coarse ? 410 : 330 }));
    setFocus(current ?? today);
    setInGrid(true);
  };
  const pick = (day: Day | null) => {
    onChange(day ? keyOf(day) : '');
    close();
  };
  const move = (next: Day) => {
    setFocus(next);
    setInGrid(true);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: Day | null = null;
    if (e.key === 'ArrowLeft') next = shift(focus, { days: -1 });
    else if (e.key === 'ArrowRight') next = shift(focus, { days: 1 });
    else if (e.key === 'ArrowUp') next = shift(focus, { days: -7 });
    else if (e.key === 'ArrowDown') next = shift(focus, { days: 7 });
    else if (e.key === 'Home') next = shift(focus, { days: -weekdayIndex(focus) });
    else if (e.key === 'End') next = shift(focus, { days: 6 - weekdayIndex(focus) });
    else if (e.key === 'PageUp') next = shift(focus, { months: e.shiftKey ? -12 : -1 });
    else if (e.key === 'PageDown') next = shift(focus, { months: e.shiftKey ? 12 : 1 });
    else if (e.key === 'Enter') {
      e.preventDefault();
      pick(focus);
      return;
    }
    if (!next) return;
    e.preventDefault();
    move(next);
  };

  /** Escape closes; Tab goes round the calendar instead of out to the page under it. */
  const onDialogKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')).filter((b) => b.tabIndex >= 0);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && e.target === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && e.target === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const days = open ? gridOf(focus) : [];
  const small = size === 'sm';

  return (
    <>
      <button
        id={id}
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? calendarId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-label={ariaLabel}
        disabled={disabled}
        autoFocus={autoFocus}
        data-tip={title}
        onClick={() => (open ? setBox(null) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            show();
          }
        }}
        className={clsx(
          'relative flex w-full min-w-0 items-center rounded-lg border bg-surface text-left transition-colors',
          'disabled:cursor-default disabled:bg-black/[0.03] disabled:text-app-text-tertiary dark:disabled:bg-white/[0.04]',
          FOCUS_RING,
          CONTROL_SIZE[size],
          invalid ? 'border-rose-500/70 dark:border-rose-400/70' : 'border-app-border-input hover:border-black/20 dark:hover:border-white/20',
          current ? 'tabular-nums text-app-text' : 'text-app-placeholder',
        )}
      >
        <CalendarDays
          size={small ? 12 : 14}
          className={clsx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-app-text-tertiary', small ? 'left-2' : 'left-2.5')}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{current ? shown(current) : placeholder ?? t.datePlaceholder}</span>
      </button>
      {name && <input type="hidden" name={name} value={value} />}
      {open && box && (
        <>
          <div
            aria-hidden="true"
            className={clsx('fixed inset-0', LAYER_FLOAT)}
            onClick={close}
            onContextMenu={(e) => {
              e.preventDefault();
              close();
            }}
          />
          <div
            id={calendarId}
            ref={focusSurface}
            role="dialog"
            aria-label={ariaLabel ?? t.pickDate}
            tabIndex={-1}
            onKeyDown={onDialogKey}
            style={{ left: box.left, top: box.top, bottom: box.bottom, maxHeight: box.maxHeight }}
            className={clsx(FLOAT_SURFACE, LAYER_FLOAT, 'fixed w-[240px] overflow-y-auto p-2 outline-none coarse:w-[296px]')}
          >
            <div className="flex items-center gap-1 pb-1">
              <button type="button" aria-label={t.prevMonth} data-tip={t.prevMonth} onClick={() => { setFocus(shift(focus, { months: -1 })); setInGrid(false); }} className={NAV}>
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <div aria-live="polite" className="min-w-0 flex-1 truncate text-center text-compact font-semibold capitalize text-app-text coarse:text-body-lg">
                {names.month.format(fromDay(focus))}
              </div>
              <button type="button" aria-label={t.nextMonth} data-tip={t.nextMonth} onClick={() => { setFocus(shift(focus, { months: 1 })); setInGrid(false); }} className={NAV}>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
            <div role="grid" aria-label={names.month.format(fromDay(focus))} onKeyDown={onGridKey}>
              <div role="row" className="grid grid-cols-7">
                {names.week.map((w) => (
                  <div key={w} role="columnheader" className="flex h-6 items-center justify-center text-mini font-medium capitalize text-app-text-tertiary">{w}</div>
                ))}
              </div>
              {Array.from({ length: 6 }, (_, row) => (
                <div key={row} role="row" className="grid grid-cols-7">
                  {days.slice(row * 7, row * 7 + 7).map((day) => {
                    const chosen = !!current && same(day, current);
                    const isToday = same(day, today);
                    const onKeyboard = same(day, focus);
                    const outside = day.m !== focus.m;
                    return (
                      <div key={keyOf(day)} role="gridcell" aria-selected={chosen} className="flex items-center justify-center">
                        <button
                          type="button"
                          ref={onKeyboard && inGrid ? focusOnMount : undefined}
                          tabIndex={onKeyboard ? 0 : -1}
                          aria-label={names.long.format(fromDay(day))}
                          aria-current={isToday ? 'date' : undefined}
                          onClick={() => pick(day)}
                          className={clsx(
                            CELL,
                            FOCUS_RING,
                            chosen
                              ? 'bg-primary font-semibold text-white hover:bg-primary-hover'
                              : clsx(
                                'hover:bg-black/[0.06] dark:hover:bg-white/[0.08]',
                                outside ? 'text-app-text-tertiary' : 'text-app-text',
                                isToday && 'font-semibold text-primary ring-1 ring-inset ring-primary/50',
                              ),
                          )}
                        >
                          {day.d}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-1 flex items-center justify-between border-t border-app-border pt-1.5">
              <button type="button" onClick={() => pick(today)} className={TEXT_BUTTON}>{t.today}</button>
              <button type="button" onClick={() => pick(null)} disabled={!current} className={clsx(TEXT_BUTTON, 'disabled:cursor-default disabled:text-app-text-tertiary disabled:hover:bg-transparent')}>{t.clear}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
