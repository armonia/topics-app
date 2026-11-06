/**
 * The proxy's raw rows summed for the Dashboard: windows from local midnight,
 * tokens with cache reads at a tenth, list dollars from the Topics price table,
 * a window cut by the proxy's 50 thousand rows said as cut, the window
 * narrowed to a model, an account or a folder (the pickers keep every value),
 * per folder and branch, input and output apart, and the CSV the hub exported.
 * @covers HUBBR-12
 */
import { describe, expect, test } from "bun:test";
import { aggregateProxyUsage, localMidnight, proxyUsageCsv, usageBuckets } from "./proxy-usage";
import { PROXY_ROW_CAP, parseUsageDays, parseUsageFilter, repoKey, usageFilterQuery } from "../../shared/hub-usage";

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

  test("the window narrowed to a model, an account or a folder; the pickers keep every value", () => {
    const rows = [
      { ...row(NOW - HOUR, "claude-opus-5-5", "lavoro@example.com", 100, 10), repo: "/w/acme-web", branch: "main" },
      { ...row(NOW - HOUR, "claude-opus-5-5", "lavoro@example.com", 50, 5), repo: "/w/acme-web", branch: "feat/x" },
      { ...row(NOW - HOUR, "claude-sonnet-5-5", "riserva@example.com", 20, 2), repo: "/w/studio-x/", branch: "main" },
      { ...row(NOW - HOUR, "claude-haiku-5-5", "riserva@example.com", 7, 1), repo: "", branch: "" },
    ];
    const all = aggregateProxyUsage(rows, 1, NOW);
    expect(all.totals).toMatchObject({ requests: 4, inputTokens: 177, outputTokens: 18 });
    expect(all.repos.map((r) => [r.key, r.requests])).toEqual([["acme-web", 2], ["studio-x", 1], ["", 1]]);
    expect(all.repos[0]!.branches.map((b) => b.key)).toEqual(["main", "feat/x"]);
    expect(all.options).toEqual({ models: ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"], accounts: ["lavoro@example.com", "riserva@example.com"], repos: ["", "acme-web", "studio-x"] });

    const folder = aggregateProxyUsage(rows, 1, NOW, { model: null, account: null, repo: "studio-x" });
    expect(folder.totals.requests).toBe(1);
    expect(folder.models.map((m) => m.key)).toEqual(["claude-sonnet-5-5"]);
    expect(folder.options.models).toHaveLength(3);
    expect(folder.filter.repo).toBe("studio-x");
    expect(aggregateProxyUsage(rows, 1, NOW, { model: null, account: null, repo: "" }).totals.requests).toBe(1);
    expect(aggregateProxyUsage(rows, 1, NOW, { model: "claude-opus-5-5", account: "riserva@example.com", repo: null }).totals.requests).toBe(0);
  });

  test("the CSV is the window's rows one line each, the filter applied, quotes doubled", () => {
    const rows = [
      { ...row(NOW - HOUR, "claude-opus-5-5", "lavoro@example.com", 100, 10), repo: '/w/a "b"', branch: "main" },
      { ...row(NOW - HOUR, "claude-sonnet-5-5", "riserva@example.com", 20, 2), repo: "/w/c", branch: "dev" },
      row(localMidnight(NOW) - 1, "claude-opus-5-5", "lavoro@example.com", 1, 1),
    ];
    const lines = proxyUsageCsv(rows, 1, NOW).split("\n");
    expect(lines[0]).toBe("timestamp,repo,branch,model,account,input_tokens,output_tokens");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`${new Date(NOW - HOUR).toISOString()},"/w/a ""b""","main","claude-opus-5-5","lavoro@example.com",100,10`);
    expect(proxyUsageCsv(rows, 1, NOW, { model: null, account: "riserva@example.com", repo: null }).split("\n")).toHaveLength(2);
  });

  test("the filter on the wire: empty is all, «-» is the empty folder, and back", () => {
    expect(parseUsageFilter(new URLSearchParams("model=claude-opus-5-5&account=&repo=-"))).toEqual({ model: "claude-opus-5-5", account: null, repo: "" });
    expect(usageFilterQuery({ model: null, account: "a@b.c", repo: "" })).toBe("&account=a%40b.c&repo=-");
    expect(repoKey("/Users/x/Projects/topics-app/")).toBe("topics-app");
    expect(repoKey(undefined)).toBe("");
  });
});
