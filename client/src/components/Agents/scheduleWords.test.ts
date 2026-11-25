/** @covers AGENTS-NAV-01 */
import { describe, expect, test } from "bun:test";
import { scheduleWords } from "./scheduleWords";

describe("scheduleWords", () => {
  test("a daily cron is spelled in words, with minutes only when not zero", () => {
    expect(scheduleWords({ kind: "cron", expr: "0 8 * * *" })).toEqual({ key: "agents.when.daily", params: { time: "8" } });
    expect(scheduleWords({ kind: "cron", expr: "30 18 * * *" }).params).toEqual({ time: "18:30" });
  });

  test("a weekday cron keeps the day, an interval says minutes or hours", () => {
    expect(scheduleWords({ kind: "cron", expr: "0 9 * * 1" })).toEqual({ key: "agents.when.weekly", params: { day: 1, time: "9" } });
    expect(scheduleWords({ kind: "every", minutes: 30 })).toEqual({ key: "agents.when.everyMinutes", params: { n: 30 } });
    expect(scheduleWords({ kind: "every", minutes: 120 })).toEqual({ key: "agents.when.everyHours", params: { n: 2 } });
  });

  test("an exotic cron never echoes the expression", () => {
    expect(scheduleWords({ kind: "cron", expr: "0 8 * * 1-5" })).toEqual({ key: "agents.when.custom", params: {} });
    expect(scheduleWords(null).key).toBe("agents.when.custom");
  });
});
