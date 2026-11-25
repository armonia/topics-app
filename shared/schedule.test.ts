/**
 * The one schedule calculation: cron with zones and the two clock changes, `every`,
 * `at`, and the validation the server and the client share.
 *
 * @covers SCHED-02
 */
import { describe, expect, test } from "bun:test";
import {
  firstOccurrence, isRepeatedWallTime, nextCronOccurrence, nextOccurrence, validateSchedule, ScheduleError,
} from "./schedule";

const at = (iso: string) => new Date(iso);

describe("cron with a zone", () => {
  test("Monday 09:00 in Rome is 08:00 UTC in winter and 07:00 in summer", () => {
    expect(nextCronOccurrence("0 9 * * 1", "Europe/Rome", at("2026-01-05T09:00:00Z")).toISOString()).toBe("2026-01-12T08:00:00.000Z");
    expect(nextCronOccurrence("0 9 * * 1", "Europe/Rome", at("2026-07-06T09:00:00Z")).toISOString()).toBe("2026-07-13T07:00:00.000Z");
  });

  test("repeated hour (clocks back): both passes are generated, only the second is flagged", () => {
    // Rome 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:30 happens at 00:30Z and at 01:30Z.
    const first = nextCronOccurrence("30 2 * * *", "Europe/Rome", at("2026-10-24T12:00:00Z"));
    const second = nextCronOccurrence("30 2 * * *", "Europe/Rome", first);
    expect([first.toISOString(), second.toISOString()]).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
    expect(isRepeatedWallTime("Europe/Rome", first)).toBe(false);
    expect(isRepeatedWallTime("Europe/Rome", second)).toBe(true);
  });

  test("repeated hour in a second zone (New York, 2026-11-01)", () => {
    const first = nextCronOccurrence("30 1 * * *", "America/New_York", at("2026-10-31T12:00:00Z"));
    const second = nextCronOccurrence("30 1 * * *", "America/New_York", first);
    expect([first.toISOString(), second.toISOString()]).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
    expect(isRepeatedWallTime("America/New_York", first)).toBe(false);
    expect(isRepeatedWallTime("America/New_York", second)).toBe(true);
  });

  test("a time that does not exist (clocks forward) invents no run, in two zones", () => {
    expect(nextCronOccurrence("30 2 * * *", "Europe/Rome", at("2026-03-28T12:00:00Z")).toISOString()).toBe("2026-03-30T00:30:00.000Z");
    // New York 2026-03-08: 02:30 does not exist, the next 02:30 is the day after (06:30Z, EDT).
    expect(nextCronOccurrence("30 2 * * *", "America/New_York", at("2026-03-07T12:00:00Z")).toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  test("an impossible date is refused without scanning every minute", () => {
    expect(() => nextCronOccurrence("0 0 30 2 *", "UTC", at("2026-01-01T00:00:00Z"))).toThrow("The rule has no run in the next eight years.");
  });
});

describe("every and at", () => {
  test("every counts from the given instant; a new job first runs after min(N, 5) minutes", () => {
    expect(nextOccurrence({ kind: "every", minutes: 10 }, at("2026-01-01T00:00:00Z"))?.toISOString()).toBe("2026-01-01T00:10:00.000Z");
    expect(firstOccurrence({ kind: "every", minutes: 60 }, at("2026-01-01T00:00:00Z"))?.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    expect(firstOccurrence({ kind: "every", minutes: 2 }, at("2026-01-01T00:00:00Z"))?.toISOString()).toBe("2026-01-01T00:02:00.000Z");
  });

  test("at has one occurrence, then none", () => {
    const schedule = { kind: "at", at: "2026-01-01T10:00:00.000Z" } as const;
    expect(nextOccurrence(schedule, at("2026-01-01T09:00:00Z"))?.toISOString()).toBe(schedule.at);
    expect(nextOccurrence(schedule, at("2026-01-01T10:00:00Z"))).toBeNull();
  });

  test("an at in the past is refused on creation, not on read", () => {
    const now = at("2026-01-01T12:00:00Z");
    expect(() => validateSchedule({ kind: "at", at: "2026-01-01T10:00:00Z" }, { now, rejectPast: true })).toThrow(ScheduleError);
    expect(validateSchedule({ kind: "at", at: "2026-01-01T10:00:00Z" }, { now }).kind).toBe("at");
  });

});

describe("validation", () => {
  test("rejects what cannot run", () => {
    expect(() => validateSchedule({ kind: "cron", expr: "* * *", tz: "UTC" })).toThrow();
    expect(() => validateSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Not/AZone" })).toThrow();
    expect(() => validateSchedule({ kind: "every", minutes: 0 })).toThrow();
    expect(() => validateSchedule({ kind: "weekly" })).toThrow();
    expect(() => validateSchedule(null)).toThrow();
  });
});
