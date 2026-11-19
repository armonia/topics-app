/**
 * What a 429 means in the light of the plan's usage windows.
 *
 * @covers RESUME-04
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { parseUsage, holdFromUsage, saturationHold, fetchUsage, releaseHoldIfFreed, releaseHoldIfEngineFree, resetEngineLift, ENGINE_LIFT_TRUST_MS, observePlanUsage, EXHAUSTED_AT } from "./usage-window";
import { providerHold, clearProviderHold, planUsage, clearPlanUsage, holdForApiDown, setProviderHold } from "../../lib/provider-hold";

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
    const refusal = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    expect(await saturationHold("tok", NOW, refusal)).toBeNull();
    expect(providerHold(NOW)).toBeNull();
  });

  test("a 401 recovers the token once and reads again", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization!;
      seen.push(auth);
      return auth === "Bearer new" ? new Response(JSON.stringify(measured)) : new Response("expired", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await fetchUsage("old", fetchImpl, async () => "new")).not.toBeNull();
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
    expect(await fetchUsage("old", fetchImpl, async () => null)).toBeNull();
  });

  test("a success under a hold lifts it only when the windows say so", async () => {
    const spentJson = { ...measured, five_hour: { utilization: 100, resets_at: RESET_5H } };
    const spent = (async () => new Response(JSON.stringify(spentJson))) as unknown as typeof fetch;
    const freed = (async () => new Response(JSON.stringify(measured))) as unknown as typeof fetch;
    // No hold in force: nothing to do, no request made.
    let asked = 0;
    const counting = (async () => { asked++; return new Response(JSON.stringify(measured)); }) as unknown as typeof fetch;
    expect(await releaseHoldIfFreed("tok", NOW, counting)).toBe(false);
    expect(asked).toBe(0);
    await saturationHold("tok", NOW, spent);
    // Still spent: the hold stays (a small request passing is not the wall gone).
    expect(await releaseHoldIfFreed("tok", NOW, spent)).toBe(false);
    expect(providerHold(NOW)).not.toBeNull();
    // Freed: the hold goes.
    expect(await releaseHoldIfFreed("tok", NOW, freed)).toBe(true);
    expect(providerHold(NOW)).toBeNull();
  });

  // The usage endpoint answering says nothing about the path the CLI's own
  // requests take (a gateway sat on it on 25/09): the recheck every 90 s would
  // have lifted an outage hold in the middle of the outage.
  test("an API outage hold is not the endpoint's to lift", async () => {
    const freed = (async () => new Response(JSON.stringify(measured))) as unknown as typeof fetch;
    holdForApiDown(NOW);
    expect(await releaseHoldIfFreed("tok", NOW, freed)).toBe(false);
    expect(providerHold(NOW)?.window).toBe("api-down");
  });
});

/**
 * One reading, two sources: the CLI event and this endpoint write the same
 * memo, and a spent window walks into the same hold either way.
 *
 * @covers USAGE-21
 */
describe("observePlanUsage", () => {
  beforeEach(() => { clearProviderHold(); clearPlanUsage(); });

  test("the percentage is recorded and, under the wall, no hold is taken", () => {
    observePlanUsage({ fiveHour: { utilization: 82, resetsAtMs: NOW + 3_600_000 }, sevenDay: null }, NOW);
    expect(planUsage(NOW)?.fiveHour?.utilization).toBe(82);
    expect(providerHold(NOW)).toBeNull();
  });

  test("a spent window takes the same hold the endpoint would", () => {
    observePlanUsage({ fiveHour: { utilization: 100, resetsAtMs: NOW + 3_600_000 }, sevenDay: null }, NOW);
    expect(providerHold(NOW)?.untilMs).toBe(NOW + 3_600_000);
    expect(providerHold(NOW)?.window).toBe("five_hour");
  });

  test("nothing read, nothing written", () => {
    observePlanUsage(null, NOW);
    expect(planUsage(NOW)).toBeNull();
  });

  test("the endpoint's own reads feed the memo too", async () => {
    const ok = (async () => new Response(JSON.stringify(measured))) as unknown as typeof fetch;
    await saturationHold("tok", NOW, ok);
    expect(planUsage(NOW)?.sevenDay?.utilization).toBe(measured.seven_day.utilization);
  });
});

describe("releaseHoldIfEngineFree", () => {
  beforeEach(() => { clearProviderHold(); resetEngineLift(); });
  const spentWeek = { untilMs: NOW + 4 * 86_400_000, window: "seven_day" as const, reason: "finestra settimanale del piano esaurita" };

  test("a spent account is no wall while the engine has a free one: the hold goes", async () => {
    setProviderHold(spentWeek, NOW);
    expect(await releaseHoldIfEngineFree(async () => true, NOW)).toBe(true);
    expect(providerHold(NOW)).toBeNull();
  });

  test("every account spent: the hold stays", async () => {
    setProviderHold(spentWeek, NOW);
    expect(await releaseHoldIfEngineFree(async () => false, NOW)).toBe(false);
    expect(providerHold(NOW)?.window).toBe("seven_day");
  });

  test("no engine, or an engine that cannot be read, decides nothing", async () => {
    setProviderHold(spentWeek, NOW);
    expect(await releaseHoldIfEngineFree(async () => null, NOW)).toBe(false);
    expect(providerHold(NOW)?.window).toBe("seven_day");
  });

  test("an API outage hold is not the engine's to lift", async () => {
    holdForApiDown(NOW);
    expect(await releaseHoldIfEngineFree(async () => true, NOW)).toBe(false);
    expect(providerHold(NOW)?.window).toBe("api-down");
  });

  test("a hold set while the engine was being read is newer than its answer: it stays", async () => {
    setProviderHold(spentWeek, NOW);
    const lifted = await releaseHoldIfEngineFree(async () => {
      // A real 429 meanwhile: the old hold is replaced by a new one.
      clearProviderHold();
      setProviderHold({ ...spentWeek, untilMs: spentWeek.untilMs + 1 }, NOW + 1);
      return true;
    }, NOW);
    expect(lifted).toBe(false);
    expect(providerHold(NOW + 2)?.untilMs).toBe(spentWeek.untilMs + 1);
  });

  test("after a lift, the CLI reading the same spent account does not set the wall again", async () => {
    setProviderHold(spentWeek, NOW);
    await releaseHoldIfEngineFree(async () => true, NOW);
    const sameWall = { five_hour: null, seven_day: { utilization: 100, resets_at: new Date(spentWeek.untilMs).toISOString() } };
    observePlanUsage(parseUsage(sameWall), NOW + 1_000);
    expect(providerHold(NOW + 1_000)).toBeNull();
    // Once the trust is over, the reading counts again.
    observePlanUsage(parseUsage(sameWall), NOW + ENGINE_LIFT_TRUST_MS + 1);
    expect(providerHold(NOW + ENGINE_LIFT_TRUST_MS + 1)?.window).toBe("seven_day");
  });

  test("a real 429 is not stopped by the lift", async () => {
    setProviderHold(spentWeek, NOW);
    await releaseHoldIfEngineFree(async () => true, NOW);
    const spent = (async () => new Response(JSON.stringify({ five_hour: null, seven_day: { utilization: 100, resets_at: new Date(spentWeek.untilMs).toISOString() } }))) as unknown as typeof fetch;
    expect(await saturationHold("tok", NOW + 1_000, spent)).toBe(spentWeek.untilMs);
    expect(providerHold(NOW + 1_000)?.window).toBe("seven_day");
  });

  test("after a lift, a different wall (another window) is set at once", async () => {
    setProviderHold(spentWeek, NOW);
    await releaseHoldIfEngineFree(async () => true, NOW);
    const fiveHourSpent = { five_hour: { utilization: 100, resets_at: new Date(NOW + 2 * 3_600_000).toISOString() }, seven_day: null };
    observePlanUsage(parseUsage(fiveHourSpent), NOW + 1_000);
    expect(providerHold(NOW + 1_000)?.window).toBe("five_hour");
  });

  test("after a lift, the same wall goes up again once the engine has no free account left", async () => {
    let free = true;
    setProviderHold(spentWeek, NOW);
    await releaseHoldIfEngineFree(async () => free, NOW);
    free = false;
    const sameWall = { five_hour: null, seven_day: { utilization: 100, resets_at: new Date(spentWeek.untilMs).toISOString() } };
    observePlanUsage(parseUsage(sameWall), NOW + 1_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(providerHold(NOW + 1_000)?.window).toBe("seven_day");
  });
});

