/**
 * Codex names the same "usage limit spent" fact Claude's usage endpoint
 * reports numerically, but as one English sentence in the error itself. This
 * is the second writer to `server/lib/provider-hold.ts` — see AGPT-01.
 *
 * @covers AGPT-01
 */
import { describe, expect, test } from "bun:test";
import { parseCodexUsageLimit } from "./usage-limit";

const NOW = Date.parse("2026-09-11T08:00:00Z");
const MESSAGE = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
  + "to purchase more credits or try again at Sep 15th, 2026 11:30 PM.";

describe("parseCodexUsageLimit", () => {
  test("reads the published reset instant out of the CLI's own sentence", () => {
    const hold = parseCodexUsageLimit(MESSAGE, NOW);
    expect(hold?.untilMs).toBe(Date.parse("2026-09-15T23:30:00"));
    expect(hold?.reason).toBe("Codex plan usage limit reached");
  });

  test("an unrelated error never becomes a hold", () => {
    expect(parseCodexUsageLimit("connection reset by peer", NOW)).toBeNull();
    expect(parseCodexUsageLimit("", NOW)).toBeNull();
  });

  test("the marker without a readable date is not a hold: no guessed instant", () => {
    expect(parseCodexUsageLimit("You've hit your usage limit. Try again later.", NOW)).toBeNull();
    expect(parseCodexUsageLimit("You've hit your usage limit. try again at whenever we feel like it.", NOW)).toBeNull();
  });

  test("a date already in the past is not adopted as a fresh hold", () => {
    const stale = "You've hit your usage limit. try again at Jan 1st, 2020 12:00 AM.";
    expect(parseCodexUsageLimit(stale, NOW)).toBeNull();
  });

  test("the date without a time still parses", () => {
    const noTime = "You've hit your usage limit. try again at Sep 15th, 2026.";
    expect(parseCodexUsageLimit(noTime, NOW)?.untilMs).toBe(Date.parse("2026-09-15"));
  });
});
