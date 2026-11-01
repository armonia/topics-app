/**
 * @covers KANBAN-85
 */
import { describe, it, expect } from "bun:test";
import { parseCloudWeeklyLimit, CLOUD_WEEKLY_LIMIT_FALLBACK_MS } from "./cloud-weekly-limit";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("parseCloudWeeklyLimit", () => {
  it("reads the reset instant out of the weekly-limit sentence", () => {
    const got = parseCloudWeeklyLimit("You've hit your weekly limit · resets Nov 4, 4am (UTC)", NOW);
    expect(got?.untilMs).toBe(Date.UTC(2026, 10, 4, 4, 0, 0));
  });
  it("rolls a past date into next year", () => {
    expect(parseCloudWeeklyLimit("You've hit your weekly limit · resets Oct 4, 4pm (UTC)", NOW)?.untilMs)
      .toBe(Date.UTC(2027, 9, 4, 16, 0, 0));
  });
  it("holds for a fallback when the zone is not UTC", () => {
    expect(parseCloudWeeklyLimit("You've hit your weekly limit · resets Nov 4, 4am (PST)", NOW)?.untilMs)
      .toBe(NOW + CLOUD_WEEKLY_LIMIT_FALLBACK_MS);
  });
  it("ignores any other message", () => {
    expect(parseCloudWeeklyLimit("Done. All tests pass.", NOW)).toBeNull();
  });
});
