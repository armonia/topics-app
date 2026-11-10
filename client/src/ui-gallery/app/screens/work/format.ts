/**
 * Dates and distances as the work screens print them, all computed from the
 * demo clock (`fixtures/org/clock.ts`) and the words of the catalogue.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import { DEMO_TODAY, daysFromToday, formatDay, formatShortDay, parseDay } from '../../../../ui/fixtures/org/clock';

/** `09:12` of an ISO date-time written with its offset. */
export const hm = (iso: string) => iso.slice(11, 16);

export const minutesSince = (iso: string, now: string) => Math.round((Date.parse(now) - Date.parse(iso.replace(' ', 'T') + (iso.length === 16 ? '+01:00' : ''))) / 60_000);

/** How old an input is: `12 min`, `2 h`, `3 gg`. */
export function ageLabel(iso: string, now: string, copy: UiCopy): string {
  const m = Math.max(0, minutesSince(iso, now));
  const t = copy.work.time;
  if (m < 60) return t.minutes(Math.max(1, m));
  if (m < 60 * 24) return t.hours(Math.floor(m / 60));
  return t.days(Math.floor(m / 1440));
}

/** `25 gg`, `oggi`, `domani`, `scaduta da 2 gg`. */
export function distanceLabel(days: number, copy: UiCopy): string {
  const t = copy.work.time;
  if (days === 0) return t.today;
  if (days === 1) return t.tomorrow;
  if (days < 0) return t.overdueBy(-days);
  return t.inDays(days);
}

export type DistanceTone = 'urgent' | 'soon' | 'later';

export function distanceTone(days: number): DistanceTone {
  if (days <= 7) return days < 0 ? 'urgent' : 'soon';
  return 'later';
}

/** `venerdì 6 novembre`. (allow-italian: quotes the Italian interface) */
export function dateLabel(day: string, copy: UiCopy): string {
  const d = parseDay(day);
  const t = copy.work.time;
  return `${t.weekdays[d.getUTCDay()]} ${d.getUTCDate()} ${t.months[d.getUTCMonth()]}`;
}

/** The time of an event of a history: `09:12` today, `05/11 09:12` before. */
export function historyAt(at: string): string {
  const day = at.slice(0, 10);
  return day === DEMO_TODAY ? at.slice(11, 16) : `${formatShortDay(day)} ${at.slice(11, 16)}`;
}

export { daysFromToday, formatDay, formatShortDay };

/** `YYYY-MM-DD HH:mm` of the demo's now, for the events the reader adds. */
export function stamp(now: string): string {
  return `${now.slice(0, 10)} ${now.slice(11, 16)}`;
}

/** `1.248,00 €` for an amount in euros. */
export const formatAmount = (n: number) => `${n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** The status id of a closed case, as the data model spells it. */
export const CLOSED = 'chiusa' as const; // allow-italian: status id of the data model, not copy
