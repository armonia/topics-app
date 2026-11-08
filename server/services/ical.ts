/**
 * iCalendar, read for one purpose: WHAT IS ON TODAY.
 *
 * This is not a general RFC 5545 implementation and does not pretend to be. It
 * reads the feed a calendar vendor publishes (Google's "secret address in iCal
 * format" and its equivalents) and answers a single question: which occurrences
 * fall inside a window a few days wide.
 *
 * WHY RECURRENCE IS HERE AND NOT SKIPPED. A calendar that ignores RRULE is not
 * a smaller calendar, it is a wrong one: the daily standup, the weekly one-to-
 * one and the monthly review are the events that actually fill a working week,
 * and a feed states them ONCE with a rule. Reading only the first instance
 * would show a stand-up that happened in March and nothing today. So the rules
 * are expanded -- daily, weekly, monthly, yearly, with INTERVAL, COUNT, UNTIL,
 * BYDAY and BYMONTHDAY -- and the cases beyond that (BYSETPOS, BYWEEKNO, and
 * the rest of the algebra) are left out on purpose: they do not appear in a
 * personal calendar, and the code that would handle them is code nobody reads.
 *
 * TIME ZONES WITHOUT A LIBRARY. A recurring event repeats on the WALL CLOCK of
 * its own zone: a 9:00 stand-up in Europe/Rome stays at 9:00 across the DST
 * change, which is a different instant before and after. So an occurrence is
 * stepped in calendar fields and converted to an instant at the end, through
 * `Intl.DateTimeFormat`, which already knows every zone the platform knows.
 * VTIMEZONE blocks in the feed are ignored: the TZID name is enough, and
 * re-deriving the offsets from the feed's own transition rules would be
 * trusting a copy over the platform's tz database.
 *
 * Pure functions, no network and no clock of their own: the window comes from
 * the caller, which is what makes this testable at a fixed instant.
 */

/** A date-time as the feed wrote it: the instant, plus the wall-clock fields
 *  and zone the recurrence has to step in. */
export interface IcsDate {
  ms: number;
  /** `VALUE=DATE`: an all-day event, no time of day in the feed. */
  dateOnly: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** IANA zone name, `UTC` for a trailing `Z`, `null` for a floating time
   *  (which means "the clock on this machine", as the RFC says). */
  zone: string | null;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  start: IcsDate;
  end: IcsDate;
  location?: string;
  description?: string;
  url?: string;
  /** Google writes the Meet link here; other vendors put it in the location or
   *  in the body, which is why `meetingUrlOf` looks in all three. */
  conference?: string;
  rrule?: string;
  /** Instants removed from the series (EXDATE), already resolved. */
  exdates: number[];
  /** Set on the VEVENT that OVERRIDES one occurrence of a series: same UID,
   *  this instant identifying which one. */
  recurrenceId?: number;
  cancelled: boolean;
}

export interface IcsCalendar {
  /** `X-WR-CALNAME`, the human name of the feed. Shown after a successful test
   *  in Settings, so the answer is "we reached YOUR calendar" and not a count
   *  of anonymous rows. */
  name?: string;
  events: IcsEvent[];
}

/** One expanded instance, ready to become a `CalendarEvent`. */
export interface IcsOccurrence {
  event: IcsEvent;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormatFor(zone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormats.get(zone);
  if (cached) return cached;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormats.set(zone, fmt);
    return fmt;
  } catch {
    // An unknown zone name is not a reason to drop the event: it falls back to
    // the machine's own clock, which is what a floating time already does.
    return null;
  }
}

/** The offset, in ms, that `zone` had at the instant `ms`. */
function zoneOffsetAt(ms: number, zone: string): number {
  const fmt = zoneFormatFor(zone);
  if (!fmt) return -new Date(ms).getTimezoneOffset() * 60_000;
  const parts = fmt.formatToParts(new Date(ms));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    read('year'), read('month') - 1, read('day'),
    read('hour'), read('minute'), read('second'),
  );
  return asUtc - ms;
}

/**
 * Wall-clock fields in a zone to an instant.
 *
 * Two passes, and the second is the one that matters: the offset has to be the
 * one in force AT the resulting instant, not at the naive guess. Without it,
 * every event in the week after a DST change lands an hour off.
 */
export function instantOf(date: Omit<IcsDate, 'ms'>): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second);
  if (date.zone === null) {
    // Floating: the machine's own zone, which `Date`'s local constructor is.
    return new Date(date.year, date.month - 1, date.day, date.hour, date.minute, date.second).getTime();
  }
  if (date.zone === 'UTC') return naive;
  const guess = naive - zoneOffsetAt(naive, date.zone);
  return naive - zoneOffsetAt(guess, date.zone);
}

// ---------------------------------------------------------------------------
// The text format
// ---------------------------------------------------------------------------

interface IcsLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Content lines, with the RFC's folding undone: a line beginning with a space
 *  or a tab is the continuation of the previous one. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

function decodeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseLine(line: string): IcsLine | null {
  const colon = splitOnColon(line);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const pieces = head.split(';');
  const name = (pieces.shift() ?? '').toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    params[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** The first colon OUTSIDE a quoted parameter value. `TZID="GMT+1:00"` is
 *  legal, and splitting on the first colon would cut the name in half. */
function splitOnColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) return i;
  }
  return -1;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/** One date value. Returns null for anything that is not a date, which the
 *  caller treats as "this event has no usable start" and drops. */
export function parseIcsDate(value: string, params: Record<string, string>): IcsDate | null {
  const m = DATE_TIME.exec(value.trim());
  if (!m) return null;
  const dateOnly = params.VALUE === 'DATE' || m[4] === undefined;
  const zone = m[7] === 'Z' ? 'UTC' : (params.TZID ?? null);
  const fields = {
    dateOnly,
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? '0'),
    minute: Number(m[5] ?? '0'),
    second: Number(m[6] ?? '0'),
    // An all-day event has no zone in the feed and must not get one: it starts
    // at midnight where the reader is, which is what a floating time means.
    zone: dateOnly ? null : zone,
  };
  return { ...fields, ms: instantOf(fields) };
}

/** ISO-8601 durations as calendars write them (`PT30M`, `P1D`, `-PT15M`). */
function parseDuration(value: string): number | null {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const n = (v: string | undefined) => Number(v ?? '0');
  const ms =
    n(m[2]) * 604_800_000 + n(m[3]) * 86_400_000 +
    n(m[4]) * 3_600_000 + n(m[5]) * 60_000 + n(m[6]) * 1000;
  return m[1] ? -ms : ms;
}

/**
 * The feed, as events. Everything that is not a VEVENT is skipped, VTIMEZONE
 * included (see the header on why the zone name is enough).
 */
export function parseIcs(text: string): IcsCalendar {
  const events: IcsEvent[] = [];
  let name: string | undefined;
  let current: Partial<IcsEvent> & { exdates: number[] } = { exdates: [] };
  let inEvent = false;

  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN' && line.value === 'VEVENT') {
      inEvent = true;
      current = { exdates: [], cancelled: false };
      continue;
    }
    if (line.name === 'END' && line.value === 'VEVENT') {
      inEvent = false;
      const done = finishEvent(current);
      if (done) events.push(done);
      continue;
    }
    if (!inEvent) {
      if (line.name === 'X-WR-CALNAME') name = decodeText(line.value).trim() || undefined;
      continue;
    }
    applyProperty(current, line);
  }

  return { name, events };
}

function applyProperty(event: Partial<IcsEvent> & { exdates: number[] }, line: IcsLine): void {
  switch (line.name) {
    case 'UID': event.uid = line.value.trim(); break;
    case 'SUMMARY': event.summary = decodeText(line.value).trim(); break;
    case 'LOCATION': event.location = decodeText(line.value).trim() || undefined; break;
    case 'DESCRIPTION': event.description = decodeText(line.value).trim() || undefined; break;
    case 'URL': event.url = line.value.trim() || undefined; break;
    case 'X-GOOGLE-CONFERENCE': event.conference = line.value.trim() || undefined; break;
    case 'RRULE': event.rrule = line.value.trim(); break;
    case 'STATUS': event.cancelled = line.value.trim().toUpperCase() === 'CANCELLED'; break;
    case 'DTSTART': {
      const d = parseIcsDate(line.value, line.params);
      if (d) event.start = d;
      break;
    }
    case 'DTEND': {
      const d = parseIcsDate(line.value, line.params);
      if (d) event.end = d;
      break;
    }
    case 'DURATION': {
      const ms = parseDuration(line.value);
      if (ms !== null && event.start) event.end = shiftDate(event.start, ms);
      break;
    }
    case 'RECURRENCE-ID': {
      const d = parseIcsDate(line.value, line.params);
      if (d) event.recurrenceId = d.ms;
      break;
    }
    case 'EXDATE': {
      // One property line may carry several instants, comma separated.
      for (const piece of line.value.split(',')) {
        const d = parseIcsDate(piece, line.params);
        if (d) event.exdates.push(d.ms);
      }
      break;
    }
    default: break;
  }
}

function shiftDate(from: IcsDate, ms: number): IcsDate {
  const moved = new Date(from.ms + ms);
  return {
    ms: from.ms + ms,
    dateOnly: from.dateOnly,
    year: moved.getFullYear(),
    month: moved.getMonth() + 1,
    day: moved.getDate(),
    hour: moved.getHours(),
    minute: moved.getMinutes(),
    second: moved.getSeconds(),
    zone: from.zone,
  };
}

function finishEvent(draft: Partial<IcsEvent> & { exdates: number[] }): IcsEvent | null {
  if (!draft.start) return null;
  const start = draft.start;
  // No end at all: an all-day event lasts the day, a timed one is a point that
  // the surfaces still have to be able to lay out, so it gets a nominal hour.
  const end = draft.end ?? shiftDate(start, start.dateOnly ? 86_400_000 : 3_600_000);
  return {
    uid: draft.uid ?? `${start.ms}-${draft.summary ?? ''}`,
    summary: draft.summary ?? '',
    start,
    end,
    location: draft.location,
    description: draft.description,
    url: draft.url,
    conference: draft.conference,
    rrule: draft.rrule,
    exdates: draft.exdates,
    recurrenceId: draft.recurrenceId,
    cancelled: draft.cancelled ?? false,
  };
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Rule {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: number | null;
  /** `MO`, or `2TU` / `-1FR` when the rule names an nth weekday of the month. */
  byDay: Array<{ day: number; nth: number | null }>;
  byMonthDay: number[];
}

function parseRule(rrule: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const piece of rrule.split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }
  const frequency = parts.FREQ?.toUpperCase();
  if (frequency !== 'DAILY' && frequency !== 'WEEKLY' && frequency !== 'MONTHLY' && frequency !== 'YEARLY') return null;
  const interval = Math.max(1, Number(parts.INTERVAL ?? '1') || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  let until: number | null = null;
  if (parts.UNTIL) {
    const d = parseIcsDate(parts.UNTIL, {});
    until = d ? d.ms : null;
  }
  const byDay = (parts.BYDAY ?? '')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)
    .map((token) => {
      const m = /^(-?\d+)?([A-Z]{2})$/.exec(token);
      if (!m) return null;
      const day = WEEKDAYS.indexOf(m[2]);
      if (day < 0) return null;
      return { day, nth: m[1] ? Number(m[1]) : null };
    })
    .filter((v): v is { day: number; nth: number | null } => v !== null);
  const byMonthDay = (parts.BYMONTHDAY ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v !== 0);
  return { frequency, interval, count, until, byDay, byMonthDay };
}

/** A hard stop on the walk. A malformed rule (INTERVAL=0 dodged, COUNT huge,
 *  UNTIL in the next century) must cost a bounded amount of work, not hang the
 *  request that asked for today's agenda. */
const MAX_STEPS = 20_000;

/** Calendar-field arithmetic on the wall clock, so an occurrence keeps its time
 *  of day across a DST change instead of drifting by an hour. */
function addDays(date: Omit<IcsDate, 'ms'>, days: number): Omit<IcsDate, 'ms'> {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { ...date, year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function addMonths(date: Omit<IcsDate, 'ms'>, months: number): Omit<IcsDate, 'ms'> {
  const total = (date.year * 12) + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  // A rule anchored on the 31st simply has no instance in a shorter month, and
  // clamping it to the 30th would invent a meeting that is not in the feed.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (date.day > daysInMonth) return { ...date, year, month, day: -1 };
  return { ...date, year, month };
}

function weekdayOf(date: Omit<IcsDate, 'ms'>): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The days of one month that match a BYDAY/BYMONTHDAY set, in order. */
function daysMatchingInMonth(anchor: Omit<IcsDate, 'ms'>, rule: Rule): number[] {
  const daysInMonth = new Date(Date.UTC(anchor.year, anchor.month, 0)).getUTCDate();
  const days = new Set<number>();
  for (const wanted of rule.byMonthDay) {
    const day = wanted > 0 ? wanted : daysInMonth + wanted + 1;
    if (day >= 1 && day <= daysInMonth) days.add(day);
  }
  for (const { day: weekday, nth } of rule.byDay) {
    const matching: number[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      if (weekdayOf({ ...anchor, day }) === weekday) matching.push(day);
    }
    if (nth === null) {
      for (const day of matching) days.add(day);
    } else {
      const picked = nth > 0 ? matching[nth - 1] : matching[matching.length + nth];
      if (picked !== undefined) days.add(picked);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * The starts of one series, from DTSTART, in order, stopping at the end of the
 * window (or at COUNT/UNTIL, whichever comes first).
 *
 * It walks from the beginning rather than jumping to the window: COUNT is
 * defined on the whole series, and a series that ended in 2024 must not
 * resurface because the walk started this morning. The step count is bounded.
 */
export function occurrenceStarts(event: IcsEvent, windowEnd: number): number[] {
  const rule = event.rrule ? parseRule(event.rrule) : null;
  if (!rule) return [event.start.ms];

  const starts: number[] = [];
  let cursor: Omit<IcsDate, 'ms'> = { ...event.start };
  let emitted = 0;
  let steps = 0;

  const emit = (fields: Omit<IcsDate, 'ms'>): 'stop' | 'go' => {
    // A day the month does not have is an occurrence the feed does not have
    // either: emitting it would let `Date.UTC` roll February 30th into March
    // and put a meeting on a day nobody scheduled.
    const daysInMonth = new Date(Date.UTC(fields.year, fields.month, 0)).getUTCDate();
    if (fields.day < 1 || fields.day > daysInMonth) return 'go';
    const ms = instantOf(fields);
    if (ms < event.start.ms) return 'go';
    if (rule.until !== null && ms > rule.until) return 'stop';
    emitted++;
    if (rule.count !== null && emitted > rule.count) return 'stop';
    starts.push(ms);
    return ms > windowEnd ? 'stop' : 'go';
  };

  while (steps++ < MAX_STEPS) {
    if (rule.frequency === 'DAILY') {
      if (emit(cursor) === 'stop') break;
      cursor = addDays(cursor, rule.interval);
      continue;
    }
    if (rule.frequency === 'WEEKLY') {
      const wanted = rule.byDay.length > 0 ? rule.byDay.map((b) => b.day) : [weekdayOf(cursor)];
      const weekStart = addDays(cursor, -weekdayOf(cursor));
      let stop = false;
      for (const day of [...wanted].sort((a, b) => a - b)) {
        if (emit(addDays(weekStart, day)) === 'stop') { stop = true; break; }
      }
      if (stop) break;
      cursor = addDays(cursor, 7 * rule.interval);
      continue;
    }
    if (rule.frequency === 'MONTHLY') {
      const days = rule.byDay.length > 0 || rule.byMonthDay.length > 0
        ? daysMatchingInMonth(cursor, rule)
        : [event.start.day];
      let stop = false;
      for (const day of days) {
        if (emit({ ...cursor, day }) === 'stop') { stop = true; break; }
      }
      if (stop) break;
      cursor = addMonths({ ...cursor, day: event.start.day }, rule.interval);
      continue;
    }
    // YEARLY: the anchor day of the anchor month, every `interval` years.
    if (emit(cursor) === 'stop') break;
    cursor = addMonths(cursor, 12 * rule.interval);
  }

  return starts;
}

/**
 * Every occurrence of every event that overlaps `[from, to)`, sorted by start.
 *
 * Overlap and not containment: a meeting that started twenty minutes ago is the
 * one you are in, and a window that only accepted future starts would drop
 * exactly it.
 */
export function expandOccurrences(calendar: IcsCalendar, from: number, to: number): IcsOccurrence[] {
  // The overrides first: same UID, a RECURRENCE-ID naming the instance they
  // replace. A moved stand-up must not show up twice.
  const overrides = new Map<string, IcsEvent>();
  for (const event of calendar.events) {
    if (event.recurrenceId !== undefined) overrides.set(`${event.uid}@${event.recurrenceId}`, event);
  }

  const out: IcsOccurrence[] = [];
  for (const event of calendar.events) {
    if (event.recurrenceId !== undefined) continue;
    const duration = Math.max(0, event.end.ms - event.start.ms);
    for (const start of occurrenceStarts(event, to)) {
      if (event.exdates.includes(start)) continue;
      const override = overrides.get(`${event.uid}@${start}`);
      const instance = override ?? event;
      if (instance.cancelled) continue;
      const realStart = override ? override.start.ms : start;
      const realEnd = override ? override.end.ms : start + duration;
      if (realEnd <= from || realStart >= to) continue;
      out.push({ event: instance, start: realStart, end: realEnd });
    }
  }

  out.sort((a, b) => a.start - b.start || a.event.summary.localeCompare(b.event.summary));
  return out;
}

/** The video call to join, looked for where the four vendors actually put it. */
export function meetingUrlOf(event: IcsEvent): string | undefined {
  if (event.conference) return event.conference;
  const pattern = /https?:\/\/[^\s<>"]*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|meet\.jit\.si)[^\s<>"]*/i;
  for (const field of [event.location, event.url, event.description]) {
    const found = field ? pattern.exec(field) : null;
    if (found) return found[0];
  }
  return undefined;
}
