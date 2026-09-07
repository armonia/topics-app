/**
 * The agenda, arranged the way it is read: BY DAY, today first.
 *
 * A flat list of twenty events with a date on each row is a table; what the
 * pinned tile has to answer is "what is next", and that answer is a short list
 * under a day heading. The arranging lives here, without JSX, so the two
 * decisions that are easy to get wrong -- which day an event belongs to, and
 * which event is happening right now -- are testable at a fixed instant instead
 * of by looking at a screenshot.
 *
 * The day an event belongs to is its LOCAL day, not a UTC one: an event at
 * 00:30 in Rome is tonight, not tomorrow morning in London.
 */
import { isEventNow, type CalendarEvent } from '../../../../shared/calendar';

export interface AgendaDay {
  /** `YYYY-MM-DD` in local time. The key of the group, and what a heading is
   *  formatted from. */
  date: string;
  /** 0 = today, 1 = tomorrow, and so on. The two nearest days get a word
   *  instead of a date, because "Today" is read faster than "8 September". */
  offset: number;
  events: CalendarEvent[];
}

function localDay(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Whole days between two instants, counted on the local calendar and not by
 *  dividing by 86400000: a DST day is 23 or 25 hours long. */
function dayOffset(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  const midnightA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const midnightB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((midnightB - midnightA) / 86_400_000);
}

/**
 * The events grouped by local day, each group in start order, at most `max`
 * events in total.
 *
 * An event ALREADY RUNNING stays in today's group even though it started
 * before `now`: it is the one thing on the list you may need to act on.
 */
export function agendaDays(events: CalendarEvent[], now: number, max = 12): AgendaDay[] {
  const days: AgendaDay[] = [];
  for (const event of events.slice(0, max)) {
    const start = Date.parse(event.start);
    if (Number.isNaN(start)) continue;
    // A meeting in progress belongs to the day it is being held on, which is
    // the day of its START even when the window opened after it.
    const date = localDay(start);
    const last = days[days.length - 1];
    if (last && last.date === date) last.events.push(event);
    else days.push({ date, offset: dayOffset(now, start), events: [event] });
  }
  return days;
}

/** The one event to point at: the one running now, else the next to start.
 *  `null` when the agenda is empty. */
export function currentEvent(events: CalendarEvent[], now: number): CalendarEvent | null {
  return events.find((e) => isEventNow(e, now)) ?? events[0] ?? null;
}
