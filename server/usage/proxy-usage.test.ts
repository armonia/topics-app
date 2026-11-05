/**
 * The proxy's raw rows summed for the Dashboard: windows from local midnight,
 * tokens with cache reads at a tenth, list dollars from the Topics price table,
 * and a window cut by the proxy's 50 thousand rows said as cut.
 * @covers HUBBR-12
 */
import { describe, expect, test } from "bun:test";
import { aggregateProxyUsage, localMidnight, usageBuckets } from "./proxy-usage";
import { PROXY_ROW_CAP, parseUsageDays } from "../../shared/hub-usage";

const HOUR = 3_600_000;
// A Wednesday at 15:30 local time.
const NOW = new Date(2026, 10, 4, 15, 30).getTime();

const row = (ts: number, model: string, account: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0) =>
  ({ ts, model, account, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, repo: "/w/acme-web", branch: "main" });

describe("HUBBR-12: proxy usage summed on the server", () => {
  test("today is hourly from local midnight, a week is seven local days", () => {
    const today = usageBuckets(1, NOW);
    expect(today.unit).toBe("hour");
    expect(today.sinceMs).toBe(localMidnight(NOW));
    expect(today.buckets).toHaveLength(16);
    const week = usageBuckets(7, NOW);
    expect(week.unit).toBe("day");
    expect(week.buckets).toHaveLength(7);
    expect(week.buckets[6]).toBe(localMidnight(NOW));
    expect(week.sinceMs).toBe(localMidnight(NOW, 6));
  });

  test("tokens weigh cache reads a tenth and dollars follow the list price", () => {
    const u = aggregateProxyUsage([
      // Opus 5.5: 4 $/M in, 20 $/M out, cache read 0.05 of input, writes 1.25.
      row(NOW - HOUR, "claude-opus-5-5", "lavoro@example.com", 1_000_000, 100_000, 10_000_000, 200_000),
      row(NOW - 2 * HOUR, "claude-sonnet-5-5", "riserva@example.com", 500_000, 50_000),
    ], 1, NOW);
    expect(u.totals.requests).toBe(2);
    expect(u.models.map((m) => m.key)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(u.models[0]!.tokens).toBe(1_000_000 + 100_000 + 200_000 + 1_000_000);
    expect(u.models[0]!.listUsd).toBeCloseTo(4 + 2 + 10 * 4 * 0.05 + 0.2 * 4 * 1.25, 6);
    expect(u.accounts.map((a) => a.key)).toEqual(["lavoro@example.com", "riserva@example.com"]);
    const opus = u.series.find((s) => s.model === "claude-opus-5-5")!;
    expect(opus.tokens[14]).toBe(u.models[0]!.tokens);
    expect(opus.tokens.reduce((a, b) => a + b, 0)).toBe(u.models[0]!.tokens);
  });

  test("rows before the window, after now or malformed do not count", () => {
    const u = aggregateProxyUsage([
      row(localMidnight(NOW) - 1, "claude-opus-5-5", "a", 10, 10),
      row(NOW + HOUR, "claude-opus-5-5", "a", 10, 10),
      { ts: "ieri" }, null,
      row(NOW - HOUR, "claude-opus-5-5", "a", 10, 10),
    ], 1, NOW);
    expect(u.totals.requests).toBe(1);
  });

  test("a full proxy history that starts inside the window is a cut window", () => {
    const start = NOW - 2 * 24 * HOUR;
    const full = Array.from({ length: PROXY_ROW_CAP }, (_, i) => row(start + i * 1000, "claude-haiku-5-5", "a", 1, 1));
    const cut = aggregateProxyUsage(full, 7, NOW);
    expect(cut.coverage).toEqual({ partial: true, fromMs: start });
    const short = aggregateProxyUsage(full.slice(0, 10), 7, NOW);
    expect(short.coverage.partial).toBe(false);
  });

  test("days from the query string: 1, 7, 30, else the week", () => {
    expect(parseUsageDays("1")).toBe(1);
    expect(parseUsageDays("30")).toBe(30);
    expect(parseUsageDays("365")).toBe(7);
    expect(parseUsageDays(null)).toBe(7);
  });
});
