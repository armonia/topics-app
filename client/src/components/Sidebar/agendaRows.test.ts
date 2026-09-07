/**
 * WHICH PINNED PAGE GETS THE BAND, and how the agenda is arranged inside it.
 *
 * Both questions are answered without a DOM on purpose: the decision "this
 * pinned tab is a calendar" is a string comparison, and "which day is this
 * event on" is arithmetic on a local calendar. Neither needs a rendered
 * sidebar to be wrong, so neither needs one to be checked.
 *
 * @covers CAL-04
 */
import { describe, expect, test } from 'bun:test';
import { isCalendarPageUrl, type CalendarEvent } from '../../../../shared/calendar';
import { agendaDays, currentEvent } from './agendaRows';

describe('which page is a calendar', () => {
  test('the calendars people pin', () => {
    expect(isCalendarPageUrl('https://calendar.google.com/calendar/u/0/r/week')).toBe(true);
    expect(isCalendarPageUrl('https://outlook.live.com/calendar/0/view/week')).toBe(true);
    expect(isCalendarPageUrl('https://calendar.proton.me/u/0')).toBe(true);
  });

  test('a mailbox on the same host is NOT a calendar', () => {
    // `outlook.live.com` is also the inbox: a pinned mailbox that started
    // showing calendar rows would be answering a question nobody asked.
    expect(isCalendarPageUrl('https://outlook.live.com/mail/0/inbox')).toBe(false);
  });

  test('anything else, and anything unparseable, is not', () => {
    expect(isCalendarPageUrl('https://github.com/armonia/topics-app')).toBe(false);
    expect(isCalendarPageUrl('not a url')).toBe(false);
    expect(isCalendarPageUrl(undefined)).toBe(false);
  });
});

/** Local time on purpose: the band shows the day the reader is living in. */
function at(y: number, m: number, d: number, h: number, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

function event(id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: id, start, end, allDay: false, ...extra };
}

describe('the agenda, by day', () => {
  const now = new Date(2026, 8, 8, 9, 30).getTime();

  test('today and tomorrow are two groups, in order', () => {
    const days = agendaDays([
      event('review', at(2026, 9, 8, 11), at(2026, 9, 8, 12)),
      event('lunch', at(2026, 9, 8, 13), at(2026, 9, 8, 14)),
      event('retro', at(2026, 9, 9, 10), at(2026, 9, 9, 11)),
    ], now);
    expect(days.map((d) => d.offset)).toEqual([0, 1]);
    expect(days[0].events.map((e) => e.id)).toEqual(['review', 'lunch']);
  });

  test('a meeting already running belongs to today, not to nowhere', () => {
    const days = agendaDays([event('standup', at(2026, 9, 8, 9, 15), at(2026, 9, 8, 9, 45))], now);
    expect(days[0].offset).toBe(0);
    expect(currentEvent(days[0].events, now)?.id).toBe('standup');
  });

  test('with nothing running, the one to point at is the next to start', () => {
    const events = [event('later', at(2026, 9, 8, 15), at(2026, 9, 8, 16))];
    expect(currentEvent(events, now)?.id).toBe('later');
    expect(currentEvent([], now)).toBeNull();
  });

  test('the list is capped: a feed of holidays does not become a scrolling band', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      event(`e${i}`, at(2026, 9, 8 + i, 10), at(2026, 9, 8 + i, 11)));
    const shown = agendaDays(many, now, 5).flatMap((d) => d.events);
    expect(shown).toHaveLength(5);
  });
});
