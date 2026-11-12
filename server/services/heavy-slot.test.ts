import { describe, expect, test } from "bun:test";
import { createHeavySlotBroker, type HeavyPressure } from "./heavy-slot";
import { acquireHeavySlot, resolveHeavyBase } from "../../scripts/heavy-slot-client";

function rig(pressure: HeavyPressure = { availableMemGB: 20, cpuPct: 10 }, maxSlots = 2) {
  const state = { t: 1_000, dead: new Set<number>(), pressure };
  const broker = createHeavySlotBroker(
    { now: () => state.t, alive: (pid) => !state.dead.has(pid), pressure: () => state.pressure },
    { maxSlots },
  );
  return { state, broker };
}

describe("heavy slot broker", () => {
  test("N+1 requests with N slots: the last waits and starts as soon as one frees", () => {
    const { broker } = rig();
    const a = broker.request({ label: "a" });
    const b = broker.request({ label: "b" });
    const c = broker.request({ label: "c" });
    expect(a.state).toBe("granted");
    expect(b.state).toBe("granted");
    expect(c.state).toBe("waiting");
    broker.release(a.id);
    expect(broker.request({ label: "c", id: c.id }).state).toBe("granted");
  });

  test("a process that died holding a slot frees it", () => {
    const { broker, state } = rig(undefined, 1);
    const a = broker.request({ label: "a", pid: 4242 });
    const b = broker.request({ label: "b" });
    expect(a.state).toBe("granted");
    expect(b.state).toBe("waiting");
    state.dead.add(4242);
    expect(broker.request({ label: "b", id: b.id }).state).toBe("granted");
  });

  test("a lease nobody renews is dropped", () => {
    const { broker, state } = rig(undefined, 1);
    broker.request({ label: "a" });
    const b = broker.request({ label: "b" });
    state.t += 100_000;
    expect(broker.request({ label: "b", id: b.id }).state).toBe("granted");
  });

  test("a lease with a live pid outlives the renewal TTL, up to the run cap", () => {
    const { broker, state } = rig(undefined, 1);
    broker.request({ label: "tsc", pid: 777 });
    const b = broker.request({ label: "b" });
    state.t += 10 * 60_000;
    expect(broker.request({ label: "b", id: b.id }).state).toBe("waiting");
    expect(broker.status().held).toHaveLength(1);
    state.t += 60 * 60_000;
    expect(broker.request({ label: "b", id: b.id }).state).toBe("granted");
  });

  test("a lease with a dead pid is freed even inside the TTL", () => {
    const { broker, state } = rig(undefined, 1);
    broker.request({ label: "tsc", pid: 777 });
    state.dead.add(777);
    expect(broker.status().held).toHaveLength(0);
  });

  test("memory decides, not the count: low memory keeps the second one out", () => {
    const { broker, state } = rig({ availableMemGB: 3, cpuPct: 5 });
    expect(broker.request({ label: "a" }).state).toBe("granted");
    expect(broker.request({ label: "b" }).state).toBe("waiting");
    state.pressure = { availableMemGB: 20, cpuPct: 5 };
    const again = broker.status().waiting[0]!;
    expect(broker.request({ label: "b", id: again.id }).state).toBe("granted");
  });

  test("critical memory holds even the first request", () => {
    const { broker } = rig({ availableMemGB: 0.8, cpuPct: 5 });
    expect(broker.request({ label: "a" }).state).toBe("waiting");
  });

  test("a waiter that stops polling leaves the line", () => {
    const { broker, state } = rig(undefined, 1);
    broker.request({ label: "a" });
    broker.request({ label: "ghost" });
    state.t += 50_000;
    expect(broker.status().waiting).toHaveLength(0);
  });
});

describe("heavy slot client base", () => {
  test("a Topics that speaks only https is found (http is refused)", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      if (url.startsWith("https://")) return new Response("{}");
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolveHeavyBase({ port: 3333, fetchFn })).toBe("https://127.0.0.1:3333");
    expect(seen).toEqual(["https://127.0.0.1:3333/api/heavy-slot"]);
  });

  test("falls back to http, honours TOPICS_URL, and gives null when nothing answers", async () => {
    const httpOnly = (async (url: string) => {
      if (url.startsWith("http://")) return new Response("{}");
      throw new Error("tls");
    }) as unknown as typeof fetch;
    expect(await resolveHeavyBase({ port: 4000, fetchFn: httpOnly })).toBe("http://127.0.0.1:4000");
    expect(await resolveHeavyBase({ url: "https://box:1/", fetchFn: httpOnly })).toBe("https://box:1");
    const none = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await resolveHeavyBase({ port: 3333, fetchFn: none })).toBeNull();
  });
});

describe("heavy slot client", () => {
  const base = "http://127.0.0.1:1";

  test("Topics off: runs at once", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await acquireHeavySlot({ base, label: "x", pid: 1, maxWaitMs: 1000, fetchFn })).toBeNull();
  });

  test("an odd answer runs at once", async () => {
    const fetchFn = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(await acquireHeavySlot({ base, label: "x", pid: 1, maxWaitMs: 1000, fetchFn })).toBeNull();
  });

  test("waits, then takes the lease and releases it", async () => {
    const calls: string[] = [];
    let n = 0;
    const fetchFn = (async (url: string) => {
      calls.push(url.split("/").pop()!);
      if (url.endsWith("/acquire")) {
        return new Response(JSON.stringify(++n < 3 ? { state: "waiting", id: "w1", position: 1, reason: "busy" } : { state: "granted", id: "w1", waitedMs: 5 }));
      }
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const lease = await acquireHeavySlot({ base, label: "x", pid: 1, maxWaitMs: 60_000, fetchFn, renewEveryMs: 0 });
    expect(lease?.id).toBe("w1");
    await lease!.release();
    await lease!.release();
    expect(calls).toEqual(["acquire", "acquire", "acquire", "release"]);
  });

  test("gives up waiting past the deadline and leaves the line", async () => {
    const calls: string[] = [];
    let t = 0;
    const fetchFn = (async (url: string) => {
      calls.push(url.split("/").pop()!);
      t += 20_000;
      return new Response(JSON.stringify({ state: "waiting", id: "w1", position: 1, reason: "busy" }));
    }) as unknown as typeof fetch;
    const lease = await acquireHeavySlot({ base, label: "x", pid: 1, maxWaitMs: 30_000, fetchFn, now: () => t });
    expect(lease).toBeNull();
    expect(calls.at(-1)).toBe("release");
  });
});
