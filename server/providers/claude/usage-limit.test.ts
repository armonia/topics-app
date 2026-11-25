import { describe, expect, it } from "bun:test";
import { CLAUDE_USAGE_LIMIT_FALLBACK_MS, parseClaudeUsageLimit } from "./usage-limit";

const NOW = Date.parse("2026-11-25T10:00:00Z");

describe("parseClaudeUsageLimit", () => {
  it("reads a same-day reset in a named zone", () => {
    // 3pm Rome (CET, UTC+1) is 14:00Z
    expect(parseClaudeUsageLimit("You've hit your limit · resets 3pm (Europe/Rome)", NOW)?.untilMs).toBe(Date.parse("2026-11-25T14:00:00Z"));
  });
  it("rolls to tomorrow when the hour has passed", () => {
    expect(parseClaudeUsageLimit("You've hit your limit · resets 9am (UTC)", NOW)?.untilMs).toBe(Date.parse("2026-11-26T09:00:00Z"));
  });
  it("reads a dated reset", () => {
    expect(parseClaudeUsageLimit("You've hit your weekly limit · resets Nov 28, 4am (UTC)", NOW)?.untilMs).toBe(Date.parse("2026-11-28T04:00:00Z"));
  });
  it("falls back to a short hold when no instant is readable", () => {
    expect(parseClaudeUsageLimit("You've hit your limit", NOW)?.untilMs).toBe(NOW + CLAUDE_USAGE_LIMIT_FALLBACK_MS);
  });
  it("ignores other messages", () => {
    expect(parseClaudeUsageLimit("API Error: 400 bad request", NOW)).toBeNull();
  });
});
