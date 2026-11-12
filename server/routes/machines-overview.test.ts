/**
 * The overview gives every machine the same row; the provider facts (cost,
 * location) appear ONLY on a machine an adapter recognises, and a node that
 * does not answer says why. Card 672744e2.
 * @covers HUBBR-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import type { MachineOverview } from "../../shared/machine-overview";
import { createMachinesOverviewRoute } from "./machines-overview";
import { createProviderRegistry, hetznerSpentThisMonth, matchServer, writeProviderToken, type ProviderAdapter } from "../services/machine-providers";
import { parseProcNetDev } from "../lib/machine-metrics";
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

function route(adapters: ProviderAdapter[], fetchImpl: typeof fetch) {
  const ctx = {
    STATE_DIR: stateDir,
    json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    readJSON: async () => null,
    matchRoute: () => null,
    machineStore: { upsertLocal: () => machines[0], list: () => machines },
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
