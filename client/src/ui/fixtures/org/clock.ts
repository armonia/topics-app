/**
 * The clock of the preview. Every date the screens print is relative to one
 * fixed moment, so «scade tra 3 giorni» reads the same today and in a month, (allow-italian: quotes the Italian interface)
 * and a screenshot does not change overnight.
 *
 * `dueDate` is the one way a deadline of the example cases is computed: days
 * counted from the day after the event (art. 155 c.1 c.p.c.), and when the
 * last day is a Saturday, a Sunday or a national holiday the term moves to the
 * next working day (art. 155 c.4-5 c.p.c.). The fixtures check recomputes
 * every deadline with it.
 */

/** Friday 6 November 2026, 10:30 in Rome. */
export const DEMO_NOW = '2026-11-06T10:30:00+01:00';
export const DEMO_TODAY = '2026-11-06';

/** National holidays of 2026 and 2027 (Easter Monday included). */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-06', '2026-04-06', '2026-04-25', '2026-05-01', '2026-06-02', '2026-08-15',
  '2026-11-01', '2026-12-08', '2026-12-25', '2026-12-26',
  '2027-01-01', '2027-01-06', '2027-03-29', '2027-04-25', '2027-05-01', '2027-06-02', '2027-08-15',
  '2027-11-01', '2027-12-08', '2027-12-25', '2027-12-26',
]);

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a UTC date. */
export function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(day: string, days: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

export function isWorkingDay(day: string): boolean {
  const wd = parseDay(day).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(day);
}

/** The deadline `days` after `from`; with `rollsOver`, moved past a non-working last day. */
export function dueDate(from: string, days: number, rollsOver: boolean): string {
  let day = addDays(from, days);
  if (!rollsOver) return day;
  while (!isWorkingDay(day)) day = addDays(day, 1);
  return day;
}

/** Whole days from the demo's today to `day` (negative when past). */
export function daysFromToday(day: string): number {
  return Math.round((parseDay(day).getTime() - parseDay(DEMO_TODAY).getTime()) / 86_400_000);
}

/** `04/01/2027` */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

/** `04/01` */
export function formatShortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
}
