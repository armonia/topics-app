/**
 * What a 429 means in the light of the plan's usage windows.
 *
 * @covers RESUME-04
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { parseUsage, holdFromUsage, saturationHold, fetchUsage, EXHAUSTED_AT } from "./usage-window";
import { providerHold, clearProviderHold } from "../../lib/provider-hold";

const NOW = Date.parse("2026-09-04T15:00:00Z");
const RESET_5H = "2026-09-04T20:49:59.852026+00:00";
const RESET_7D = "2026-09-09T14:59:59.852048+00:00";

// The endpoint's answer as measured on 2026-09-04 at 15:51Z, two minutes after
// the five-hour reset that ended three hours of 429s.
const measured = {
  five_hour: { utilization: 2.0, resets_at: RESET_5H, limit_dollars: null },
  seven_day: { utilization: 92.0, resets_at: RESET_7D },
  seven_day_opus: null,
};

describe("the usage windows", () => {
  beforeEach(() => clearProviderHold());

  test("the two windows are read from the endpoint's JSON, the rest ignored", () => {
    const u = parseUsage(measured);
    expect(u.fiveHour).toEqual({ utilization: 2.0, resetsAtMs: Date.parse(RESET_5H) });
    expect(u.sevenDay).toEqual({ utilization: 92.0, resetsAtMs: Date.parse(RESET_7D) });
    expect(parseUsage(null)).toEqual({ fiveHour: null, sevenDay: null });
    expect(parseUsage({ five_hour: { utilization: "x" } }).fiveHour).toBeNull();
  });

  test("neither window spent: the 429 is the per-minute kind, no hold", () => {
    expect(holdFromUsage(parseUsage(measured), NOW)).toBeNull();
  });

  test("the five-hour window at the wall: hold until its reset", () => {
    const u = parseUsage({ ...measured, five_hour: { utilization: 100, resets_at: RESET_5H } });
    expect(holdFromUsage(u, NOW)).toEqual({ untilMs: Date.parse(RESET_5H), window: "five_hour", reason: "finestra di 5 ore del piano esaurita" });
    // The API rounds: a hair below the wall is the wall.
    const near = parseUsage({ ...measured, five_hour: { utilization: EXHAUSTED_AT, resets_at: RESET_5H } });
    expect(holdFromUsage(near, NOW)).not.toBeNull();
  });

  test("the week spent too: the longer wall wins", () => {
    const u = parseUsage({
      five_hour: { utilization: 100, resets_at: RESET_5H },
      seven_day: { utilization: 100, resets_at: RESET_7D },
    });
    expect(holdFromUsage(u, NOW)?.untilMs).toBe(Date.parse(RESET_7D));
    expect(holdFromUsage(u, NOW)?.reason).toBe("finestra settimanale del piano esaurita");
  });

  test("a reset already in the past is no hold: the window is fresh", () => {
    const u = parseUsage({ five_hour: { utilization: 100, resets_at: "2026-09-04T14:00:00Z" } });
    expect(holdFromUsage(u, NOW)).toBeNull();
  });

  test("saturationHold answers with the reset and records the hold for everyone", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ...measured, five_hour: { utilization: 100, resets_at: RESET_5H } }))) as unknown as typeof fetch;
    expect(await saturationHold("tok", NOW, fetchImpl)).toBe(Date.parse(RESET_5H));
    expect(providerHold(NOW)?.untilMs).toBe(Date.parse(RESET_5H));
  });

  test("an endpoint that is down decides nothing", async () => {
    const down = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await fetchUsage("tok", down)).toBeNull();
    const denied = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    expect(await saturationHold("tok", NOW, denied)).toBeNull();
    expect(providerHold(NOW)).toBeNull();
  });
});
