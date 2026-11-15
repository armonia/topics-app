/**
 * The overview gives every machine the same row; the provider facts (cost,
 * location) appear ONLY on a machine an adapter recognises, and a node that
 * does not answer says why. Card 672744e2.
 * @covers HUBBR-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import type { MachineOverview } from "../../shared/machine-overview";
import { createMachinesOverviewRoute } from "./machines-overview";
import { createProviderRegistry, hetznerSpentThisMonth, matchServer, providerTokenPath, readProviderToken, writeProviderToken, type ProviderAdapter } from "../services/machine-providers";
import { parseProcNetDev } from "../lib/machine-metrics";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { writeNodeToken } from "../services/node-client";

let stateDir: string;
beforeAll(() => { stateDir = mkdtempSync(join(tmpdir(), "overview-")); });
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const fakeAdapter: ProviderAdapter = {
  id: "fakecloud",
  label: "Fake Cloud",
  listServers: async () => [{
    name: "node-one", ipv4: null, status: "running",
    facts: { provider: "fakecloud", providerLabel: "Fake Cloud", monthly: { amount: 4.5, currency: "EUR" }, spentThisMonth: { amount: 1.2, currency: "EUR" }, location: "Somewhere", serverType: "small", createdAt: 0 },
  }],
};

const machines = [
  { id: "local-1", name: "This computer", hostname: "h-local", platform: "darwin", baseUrl: null },
  { id: "node-1", name: "node-one", hostname: "h-node", platform: "linux", baseUrl: "http://node.invalid:3341" },
  { id: "node-2", name: "other", hostname: "h-other", platform: "linux", baseUrl: "http://other.invalid:3341" },
];

function route(adapters: ProviderAdapter[], fetchImpl: typeof fetch, list: typeof machines = machines) {
  const ctx = {
    STATE_DIR: stateDir,
    json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    readJSON: async () => null,
    matchRoute: () => null,
    machineStore: { upsertLocal: () => list[0], list: () => list },
  } as unknown as AppContext;
  const registry = createProviderRegistry({ stateDir, adapters, fetchImpl });
  return createMachinesOverviewRoute(ctx, { registry, fetchImpl });
}

const nodeFetch = (async (url: string) => {
  if (String(url).startsWith("http://node.invalid")) {
    return Response.json({ metrics: { cpuPct: 12, memPct: 40, memUsedGB: 1.6, memTotalGB: 4, diskPct: 30, netInBps: 100, netOutBps: 50, uptimeSec: 9, rebootRequired: true, cores: 2 } });
  }
  throw new Error("refused");
}) as unknown as typeof fetch;

async function read(r: ReturnType<typeof route>): Promise<MachineOverview> {
  const url = new URL("http://x/api/machines/overview");
  return (await (await r(new Request(url), url, url.pathname, "GET"))!.json()) as MachineOverview;
}

describe("machines overview", () => {
  test("a node behind a loopback tunnel is matched by the hostname or IP it reports itself", async () => {
    const viaTunnel = [
      machines[0],
      { id: "node-3", name: "Cloud node", hostname: "", platform: "linux", baseUrl: "http://127.0.0.1:3401" },
      { id: "node-4", name: "Cloud node 2", hostname: "", platform: "linux", baseUrl: "http://127.0.0.1:3402" },
    ];
    writeNodeToken(stateDir, "node-3", "c".repeat(32));
    writeNodeToken(stateDir, "node-4", "d".repeat(32));
    const adapter: ProviderAdapter = {
      ...fakeAdapter,
      listServers: async () => [
        { ...(await fakeAdapter.listServers("", fetch, 0))[0], name: "reported-name", ipv4: "203.0.113.9" },
      ],
    };
    const metrics = { cpuPct: 1, memPct: 1, memUsedGB: 1, memTotalGB: 4, diskPct: 1, netInBps: 0, netOutBps: 0, uptimeSec: 1, cores: 2 };
    const fetchImpl = (async (url: string) => {
      if (String(url).startsWith("http://127.0.0.1:3401")) return Response.json({ metrics, hostname: "Reported-Name", publicIps: [] });
      if (String(url).startsWith("http://127.0.0.1:3402")) return Response.json({ metrics, hostname: "unrelated", publicIps: ["203.0.113.9"] });
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(writeProviderToken(stateDir, "fakecloud", "t".repeat(32))).toBe(true);
    const o = await read(route([adapter], fetchImpl, viaTunnel));
    const by = Object.fromEntries(o.machines.map((m) => [m.id, m]));
    expect(by["node-3"].provider?.location).toBe("Somewhere");
    expect(by["node-4"].provider?.monthly?.amount).toBe(4.5);
  });

  test("provider facts only on the machine the adapter recognises; a silent node says why", async () => {
    writeNodeToken(stateDir, "node-1", "a".repeat(32));
    writeNodeToken(stateDir, "node-2", "b".repeat(32));
    expect(writeProviderToken(stateDir, "fakecloud", "t".repeat(32))).toBe(true);
    const o = await read(route([fakeAdapter], nodeFetch));
    const by = Object.fromEntries(o.machines.map((m) => [m.id, m]));
    expect(by["local-1"].local).toBe(true);
    expect(by["local-1"].provider).toBeNull();
    expect(by["node-1"].state).toBe("live");
    expect(by["node-1"].metrics?.rebootRequired).toBe(true);
    expect(by["node-1"].provider?.monthly?.amount).toBe(4.5);
    expect(by["node-2"].provider).toBeNull();
    expect(by["node-2"].state).toBe("unreachable");
    expect(by["node-2"].reason).toBe("unreachable");
    expect(o.providers).toEqual([{ id: "fakecloud", label: "Fake Cloud", configured: true }]);
  });

  test("without the adapter no machine carries a cost (mutation guard)", async () => {
    const o = await read(route([], nodeFetch));
    expect(o.machines.every((m) => m.provider === null)).toBe(true);
  });

  test("a machine the provider reports powered off is stopped, not broken", async () => {
    const off: ProviderAdapter = { ...fakeAdapter, listServers: async () => [{ ...(await fakeAdapter.listServers("", fetch, 0))[0], name: "other", status: "off" }] };
    const o = await read(route([off], nodeFetch));
    const m = o.machines.find((x) => x.id === "node-2")!;
    expect(m.state).toBe("stopped");
    expect(m.reason).toBe("powered_off");
  });
});

describe("helpers", () => {
  test("matchServer by name or address", () => {
    const s = [{ name: "Alpha", ipv4: "203.0.113.5" }] as never[];
    expect(matchServer(s, { name: "alpha", hostname: "", baseUrl: null })).not.toBeNull();
    expect(matchServer(s, { name: "x", hostname: "y", baseUrl: "https://203.0.113.5:3341" })).not.toBeNull();
    expect(matchServer(s, { name: "x", hostname: "y", baseUrl: null })).toBeNull();
  });

  test("matchServer uses what the node reports, never a loopback base_url", () => {
    const s = [{ name: "alpha", ipv4: "203.0.113.5" }, { name: "beta", ipv4: "127.0.0.1" }] as never[];
    const base = { name: "Cloud 1", hostname: "", baseUrl: "http://127.0.0.1:3401" };
    expect(matchServer(s, { ...base, reportedHostname: "Alpha" })).toBe(s[0]);
    expect(matchServer(s, { ...base, reportedIps: ["203.0.113.5"] })).toBe(s[0]);
    expect(matchServer(s, base)).toBeNull();
  });
  test("hetzner spend is hourly, capped at the monthly price", () => {
    const now = Date.UTC(2026, 10, 15);
    expect(hetznerSpentThisMonth(Date.UTC(2026, 0, 1), now, 0.01, 4)).toBe(3.36);
    expect(hetznerSpentThisMonth(Date.UTC(2026, 0, 1), now, 1, 4)).toBe(4);
  });
  test("net counters skip loopback", () => {
    const text = "Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 4 0 0 0 0 0 0\n";
    expect(parseProcNetDev(text)).toEqual({ rx: 1000, tx: 2000 });
  });
});

describe("provider token on disk", () => {
  // The LaunchAgent's state dir is the repo root: the token must land in a
  // folder git ignores, never next to the code.
  test("lives under data/providers with mode 0600, a path git ignores", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptoken-"));
    try {
      expect(writeProviderToken(dir, "fakecloud", "k".repeat(32))).toBe(true);
      const f = providerTokenPath(dir, "fakecloud");
      expect(f).toBe(join(dir, "data", "providers", "fakecloud.token"));
      expect(statSync(f).mode & 0o777).toBe(0o600);
      const repo = join(import.meta.dir, "..", "..");
      // check-ignore exits 0 only when the path is ignored; otherwise execFileSync throws.
      expect(() => execFileSync("git", ["check-ignore", "--no-index", "-q", "data/providers/fakecloud.token"], { cwd: repo, stdio: "pipe", env: gitEnv() })).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a token written by the first version moves to data/providers on first read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptoken-"));
    try {
      mkdirSync(join(dir, "providers"));
      writeFileSync(join(dir, "providers", "fakecloud.token"), "o".repeat(32), { mode: 0o644 });
      expect(readProviderToken(dir, "fakecloud")).toBe("o".repeat(32));
      expect(existsSync(join(dir, "providers"))).toBe(false);
      const f = providerTokenPath(dir, "fakecloud");
      expect(readFileSync(f, "utf8")).toBe("o".repeat(32));
      expect(statSync(f).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
