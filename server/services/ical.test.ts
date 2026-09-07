/**
 * The feed reader, at a FIXED instant.
 *
 * Every case here pins `now` and asserts on what a window shows: a calendar
 * test that reads the wall clock passes in March and fails in October, which is
 * the one failure mode this file exists to avoid.
 *
 * The recurring cases are not decoration. The stand-up, the weekly one-to-one
 * and the DST change are what a personal calendar is MADE of, and a reader that
 * ignores RRULE does not show a smaller agenda, it shows a wrong one.
 *
 * @covers CAL-03
 */
import { describe, expect, test } from "bun:test";
import { expandOccurrences, meetingUrlOf, parseIcs } from "./ical";

function feed(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Work", ...events, "END:VCALENDAR"].join("\r\n");
}

const day = 86_400_000;

describe("the text format", () => {
  test("a folded line is one value, and the escapes come back as characters", () => {
    const cal = parseIcs(feed(
      "BEGIN:VEVENT",
      "UID:folded@example.com",
      "SUMMARY:Sprint review with the whole",
      "  team\\, and the guests",
      "DTSTART:20260908T090000Z",
      "DTEND:20260908T100000Z",
      "END:VEVENT",
    ));
    expect(cal.events[0].summary).toBe("Sprint review with the whole team, and the guests");
    expect(cal.name).toBe("Work");
  });

  test("an all-day event starts at local midnight and lasts the day", () => {
    const cal = parseIcs(feed(
      "BEGIN:VEVENT",
      "UID:holiday@example.com",
      "SUMMARY:Public holiday",
      "DTSTART;VALUE=DATE:20260908",
      "DTEND;VALUE=DATE:20260909",
      "END:VEVENT",
    ));
    const event = cal.events[0];
    expect(event.start.dateOnly).toBe(true);
    expect(new Date(event.start.ms).getHours()).toBe(0);
    expect(event.end.ms - event.start.ms).toBe(day);
  });

  test("DURATION stands in for a missing DTEND", () => {
    const cal = parseIcs(feed(
      "BEGIN:VEVENT",
      "UID:short@example.com",
      "DTSTART:20260908T090000Z",
      "DURATION:PT45M",
      "END:VEVENT",
    ));
    expect(cal.events[0].end.ms - cal.events[0].start.ms).toBe(45 * 60_000);
  });

  test("a zone name is honoured: 09:00 in Rome is 07:00 UTC in September", () => {
    const cal = parseIcs(feed(
      "BEGIN:VEVENT",
      "UID:rome@example.com",
      "DTSTART;TZID=Europe/Rome:20260908T090000",
      "DTEND;TZID=Europe/Rome:20260908T093000",
      "END:VEVENT",
    ));
    expect(new Date(cal.events[0].start.ms).toISOString()).toBe("2026-09-08T07:00:00.000Z");
  });
});

describe("recurrence", () => {
  const standup = (rule: string) => feed(
    "BEGIN:VEVENT",
    "UID:standup@example.com",
    "SUMMARY:Stand-up",
    "DTSTART;TZID=Europe/Rome:20260302T090000",
    "DTEND;TZID=Europe/Rome:20260302T091500",
    `RRULE:${rule}`,
    "END:VEVENT",
  );

  test("a daily rule from months ago still fills this week", () => {
    const from = Date.UTC(2026, 8, 7, 6, 0);
    const found = expandOccurrences(parseIcs(standup("FREQ=DAILY")), from, from + 3 * day);
    expect(found.length).toBe(3);
    expect(new Date(found[0].start).toISOString()).toBe("2026-09-07T07:00:00.000Z");
  });

  test("weekly BYDAY expands to the named days only", () => {
    const from = Date.UTC(2026, 8, 7, 0, 0);
    const found = expandOccurrences(parseIcs(standup("FREQ=WEEKLY;BYDAY=MO,WE,FR")), from, from + 7 * day);
    expect(found.map((o) => new Date(o.start).getUTCDay())).toEqual([1, 3, 5]);
  });

  test("the wall clock survives the DST change", () => {
    // Italy leaves summer time on 25 October 2026: the same 09:00 is 07:00Z
    // before and 08:00Z after. A naive "add 24h" drifts by an hour here.
    const from = Date.UTC(2026, 9, 24, 0, 0);
    const found = expandOccurrences(parseIcs(standup("FREQ=DAILY")), from, from + 3 * day);
    expect(new Date(found[0].start).toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(new Date(found[2].start).toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  test("COUNT is spent on the whole series, so an ended series does not resurface", () => {
    const from = Date.UTC(2026, 8, 7, 0, 0);
    expect(expandOccurrences(parseIcs(standup("FREQ=DAILY;COUNT=5")), from, from + 7 * day)).toHaveLength(0);
  });

  test("UNTIL closes the series", () => {
    const from = Date.UTC(2026, 8, 7, 0, 0);
    expect(expandOccurrences(parseIcs(standup("FREQ=DAILY;UNTIL=20260601T000000Z")), from, from + 7 * day)).toHaveLength(0);
  });

  test("INTERVAL skips the weeks in between", () => {
    const from = Date.UTC(2026, 8, 7, 0, 0);
    const found = expandOccurrences(parseIcs(standup("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")), from, from + 21 * day);
    expect(found.length).toBe(1);
  });

  test("monthly BYDAY picks the nth weekday, and never a day the month lacks", () => {
    const monthly = feed(
      "BEGIN:VEVENT",
      "UID:review@example.com",
      "SUMMARY:Monthly review",
      "DTSTART;TZID=Europe/Rome:20260106T140000",
      "DTEND;TZID=Europe/Rome:20260106T150000",
      "RRULE:FREQ=MONTHLY;BYDAY=1TU",
      "END:VEVENT",
    );
    const from = Date.UTC(2026, 8, 1, 0, 0);
    const found = expandOccurrences(parseIcs(monthly), from, from + 40 * day);
    expect(found.length).toBe(2);
    expect(new Date(found[0].start).getUTCDate()).toBe(1);
  });

  test("EXDATE removes the cancelled instance and nothing else", () => {
    const with_exdate = feed(
      "BEGIN:VEVENT",
      "UID:standup@example.com",
      "SUMMARY:Stand-up",
      "DTSTART;TZID=Europe/Rome:20260907T090000",
      "DTEND;TZID=Europe/Rome:20260907T091500",
      "RRULE:FREQ=DAILY",
      "EXDATE;TZID=Europe/Rome:20260908T090000",
      "END:VEVENT",
    );
    const from = Date.UTC(2026, 8, 7, 0, 0);
    const found = expandOccurrences(parseIcs(with_exdate), from, from + 3 * day);
    expect(found.map((o) => new Date(o.start).getUTCDate())).toEqual([7, 9]);
  });

  test("a moved instance replaces its own occurrence instead of doubling it", () => {
    const moved = feed(
      "BEGIN:VEVENT",
      "UID:standup@example.com",
      "SUMMARY:Stand-up",
      "DTSTART;TZID=Europe/Rome:20260907T090000",
      "DTEND;TZID=Europe/Rome:20260907T091500",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:standup@example.com",
      "SUMMARY:Stand-up (later)",
      "RECURRENCE-ID;TZID=Europe/Rome:20260908T090000",
      "DTSTART;TZID=Europe/Rome:20260908T110000",
      "DTEND;TZID=Europe/Rome:20260908T111500",
      "END:VEVENT",
    );
    const from = Date.UTC(2026, 8, 8, 0, 0);
    const found = expandOccurrences(parseIcs(moved), from, from + day);
    expect(found).toHaveLength(1);
    expect(found[0].event.summary).toBe("Stand-up (later)");
    expect(new Date(found[0].start).toISOString()).toBe("2026-09-08T09:00:00.000Z");
  });

  test("a cancelled event is not on the agenda", () => {
    const cancelled = feed(
      "BEGIN:VEVENT",
      "UID:gone@example.com",
      "SUMMARY:Called off",
      "STATUS:CANCELLED",
      "DTSTART:20260908T090000Z",
      "DTEND:20260908T100000Z",
      "END:VEVENT",
    );
    const from = Date.UTC(2026, 8, 8, 0, 0);
    expect(expandOccurrences(parseIcs(cancelled), from, from + day)).toHaveLength(0);
  });
});

describe("the window", () => {
  const meeting = feed(
    "BEGIN:VEVENT",
    "UID:running@example.com",
    "SUMMARY:Design review",
    "DTSTART:20260908T090000Z",
    "DTEND:20260908T100000Z",
    "END:VEVENT",
  );

  test("an event already running is IN the window, because it is the one you are in", () => {
    const now = Date.UTC(2026, 8, 8, 9, 20);
    expect(expandOccurrences(parseIcs(meeting), now, now + day)).toHaveLength(1);
  });

  test("an event that already ended is out", () => {
    const now = Date.UTC(2026, 8, 8, 10, 0);
    expect(expandOccurrences(parseIcs(meeting), now, now + day)).toHaveLength(0);
  });

  test("a malformed rule costs bounded work instead of hanging", () => {
    const broken = feed(
      "BEGIN:VEVENT",
      "UID:broken@example.com",
      "DTSTART:20200101T090000Z",
      "DTEND:20200101T093000Z",
      "RRULE:FREQ=DAILY;INTERVAL=0;COUNT=999999999",
      "END:VEVENT",
    );
    const now = Date.UTC(2026, 8, 8, 0, 0);
    const started = Date.now();
    expandOccurrences(parseIcs(broken), now, now + day);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("the link to join", () => {
  test("Google's own property wins, then the location, then the body", () => {
    const cal = parseIcs(feed(
      "BEGIN:VEVENT",
      "UID:call@example.com",
      "DTSTART:20260908T090000Z",
      "DTEND:20260908T093000Z",
      "LOCATION:Room 2",
      "DESCRIPTION:Join at https://zoom.us/j/123456",
      "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
    ));
    expect(meetingUrlOf(cal.events[0])).toBe("https://meet.google.com/abc-defg-hij");
  });

  test("a room without a link is not a link", () => {
    const cal = parseIcs(feed(
      "BEGIN:VEVENT",
      "UID:room@example.com",
      "DTSTART:20260908T090000Z",
      "DTEND:20260908T093000Z",
      "LOCATION:Room 2",
      "END:VEVENT",
    ));
    expect(meetingUrlOf(cal.events[0])).toBeUndefined();
  });
});
