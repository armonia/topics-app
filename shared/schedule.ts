/**
 * The one place that knows what a schedule means (rule R2 of the scheduled-jobs
 * engine). Server, client (preview of the next occurrences) and validation all
 * import it, so the three cannot drift. No dependency: a 5-field cron parser plus
 * `every` and `at`.
 */

export type JobSchedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'every'; minutes: number }
  | { kind: 'at'; at: string };

/** Zone used when a cron schedule names none. */
export const DEFAULT_TIME_ZONE = 'Europe/Rome';

/** First run of a new `every` job: creation + min(N, this). */
export const EVERY_FIRST_RUN_CAP_MINUTES = 5;

export class ScheduleError extends Error {}

const FIELDS = [
  { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
  { min: 1, max: 12 }, { min: 0, max: 7 },
] as const;

function parseCron(expression: string): Set<number>[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError('A cron rule needs five fields.');
  return parts.map((part, index) => {
    const { min, max } = FIELDS[index];
    const values = new Set<number>();
    for (const term of part.split(',')) {
      const [rangeText, stepText] = term.split('/');
      if (term.split('/').length > 2 || (stepText && !/^\d+$/.test(stepText))) throw new ScheduleError('Invalid cron field.');
      const step = stepText ? Number(stepText) : 1;
      if (step < 1) throw new ScheduleError('The cron step must be positive.');
      let start: number; let end: number;
      if (rangeText === '*') { start = min; end = max; }
      else if (/^\d+$/.test(rangeText)) { start = Number(rangeText); end = term.includes('/') ? max : start; }
      else {
        const range = /^(\d+)-(\d+)$/.exec(rangeText);
        if (!range) throw new ScheduleError('Invalid cron field.');
        start = Number(range[1]); end = Number(range[2]);
      }
      if (start < min || end > max || start > end) throw new ScheduleError('Cron value out of range.');
      for (let value = start; value <= end; value += step) values.add(value);
    }
    if (index === 4 && values.has(7)) values.add(0);
    if (!values.size) throw new ScheduleError('Empty cron field.');
    return values;
  });
}

function zonedDateParts(instant: Date, clockFormat: Intl.DateTimeFormat) {
  const parts = clockFormat.formatToParts(instant);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function clockFormatFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
}

/** First minute strictly after `after` that matches a 5-field cron in `timeZone`. */
export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  let parsed: Set<number>[];
  let clockFormat: Intl.DateTimeFormat;
  try {
    parsed = parseCron(expression);
    clockFormat = clockFormatFor(timeZone);
  } catch (error) {
    if (error instanceof ScheduleError) throw error;
    throw new ScheduleError('Invalid time zone or cron rule.');
  }
  const afterLocal = zonedDateParts(after, clockFormat);
  const firstDate = new Date(Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day) - 86_400_000);
  const [minutes, hours, days, months, weekdays] = parsed;
  const fieldsText = expression.trim().split(/\s+/);
  const anyDay = fieldsText[2] === '*';
  const anyWeekday = fieldsText[4] === '*';
  for (let offsetDay = 0; offsetDay <= 8 * 366 + 3; offsetDay++) {
    const date = new Date(firstDate.getTime() + offsetDay * 86_400_000);
    const year = date.getUTCFullYear(); const month = date.getUTCMonth() + 1; const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (!months.has(month)) continue;
    const dateMatches = days.has(day); const weekdayMatches = weekdays.has(weekday);
    if (!(anyDay ? weekdayMatches : anyWeekday ? dateMatches : dateMatches || weekdayMatches)) continue;

    // Sample nearby offsets to handle DST transitions without scanning every minute.
    const wallNoon = Date.UTC(year, month - 1, day, 12);
    const offsets = new Set<number>();
    for (let delta = -36; delta <= 36; delta += 6) {
      const sample = new Date(wallNoon + delta * 3_600_000);
      const local = zonedDateParts(sample, clockFormat);
      const sampleMinute = Math.floor(sample.getTime() / 60_000) * 60_000;
      offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sampleMinute);
    }

    let first: number | null = null;
    for (const hour of hours) for (const minute of minutes) for (const zoneOffset of offsets) {
      const timestamp = Date.UTC(year, month - 1, day, hour, minute) - zoneOffset;
      if (timestamp <= after.getTime() || (first !== null && timestamp >= first)) continue;
      const candidate = new Date(timestamp);
      const local = zonedDateParts(candidate, clockFormat);
      if (local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute) first = timestamp;
    }
    if (first !== null) return new Date(first);
  }
  throw new ScheduleError('The rule has no run in the next eight years.');
}

/**
 * True when `instant` is the SECOND pass over a wall-clock time that happens twice
 * (the clocks go back): the same local hour and minute were already on the clock
 * 30 or 60 minutes earlier. The occurrence key is the UTC instant, so the two
 * passes are different keys; this explicit check is what keeps a daily job at
 * 02:30 from running twice on the night the hour repeats (R5).
 */
export function isRepeatedWallTime(timeZone: string, instant: Date): boolean {
  const clockFormat = clockFormatFor(timeZone);
  const wall = (date: Date) => {
    const p = zonedDateParts(date, clockFormat);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const here = wall(instant);
  return [30, 60].some(minutes => wall(new Date(instant.getTime() - minutes * 60_000)) === here);
}

/** Throws a ScheduleError when the schedule cannot run; `at` in the past only when `rejectPast`. */
export function validateSchedule(value: unknown, options: { now?: Date; rejectPast?: boolean; requireZone?: boolean } = {}): JobSchedule {
  if (!value || typeof value !== 'object') throw new ScheduleError('Schedule missing.');
  const s = value as Record<string, unknown>;
  if (s.kind === 'cron') {
    if (typeof s.expr !== 'string') throw new ScheduleError('The cron rule is required.');
    if (s.tz !== undefined && typeof s.tz !== 'string') throw new ScheduleError('Invalid time zone.');
    if (options.requireZone && !s.tz) throw new ScheduleError('Invalid time zone.');
    const tz = (s.tz as string | undefined)?.trim() || DEFAULT_TIME_ZONE;
    const cronText = s.expr.trim();
    nextCronOccurrence(cronText, tz, options.now ?? new Date());
    return { kind: 'cron', expr: cronText, tz };
  }
  if (s.kind === 'every') {
    if (typeof s.minutes !== 'number' || !Number.isInteger(s.minutes) || s.minutes < 1) throw new ScheduleError('minutes must be a whole number above 0');
    return { kind: 'every', minutes: s.minutes };
  }
  if (s.kind === 'at') {
    const parsed = typeof s.at === 'string' ? Date.parse(s.at) : Number.NaN;
    if (Number.isNaN(parsed)) throw new ScheduleError('at must be a date and time');
    if (options.rejectPast && parsed <= (options.now ?? new Date()).getTime()) throw new ScheduleError('An `at` time in the past cannot be created.');
    return { kind: 'at', at: new Date(parsed).toISOString() };
  }
  throw new ScheduleError('Unknown schedule kind.');
}

/** The occurrence after `after` (`every` counts from `after`; a spent `at` has none). */
export function nextOccurrence(schedule: JobSchedule, after: Date): Date | null {
  if (schedule.kind === 'cron') return nextCronOccurrence(schedule.expr, schedule.tz, after);
  if (schedule.kind === 'every') return new Date(after.getTime() + schedule.minutes * 60_000);
  const at = new Date(schedule.at);
  return at.getTime() > after.getTime() ? at : null;
}

/** When a brand new job first runs. */
export function firstOccurrence(schedule: JobSchedule, now: Date): Date | null {
  if (schedule.kind === 'every') return new Date(now.getTime() + Math.min(schedule.minutes, EVERY_FIRST_RUN_CAP_MINUTES) * 60_000);
  return nextOccurrence(schedule, now);
}

