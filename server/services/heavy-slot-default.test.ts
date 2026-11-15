/**
 * A Topics session's heavy command stands in the SERVER's line, light ones never touch it.
 * @covers KANBAN-114
 */
import { describe, expect, test } from "bun:test";
import { createHeavySlotBroker, type HeavySlotBroker } from "./heavy-slot";
import { acquireHeavySlotForCommand } from "./heavy-slot-default";
import { isHeavyCommand } from "../lib/heavy-command";

/** The server's routes in miniature: one broker behind `fetch`, as a detached turn-host reaches it. */
function server(maxSlots = 1) {
  const dead = new Set<number>();
  const broker: HeavySlotBroker = createHeavySlotBroker(
    { now: () => Date.now(), alive: (pid) => !dead.has(pid), pressure: () => ({ availableMemGB: 20, cpuPct: 10 }) },
    { maxSlots },
  );
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as { label?: string; pid?: number; id?: string };
    if (path.endsWith("/acquire")) {
      const answer = broker.request({ label: body.label ?? "", pid: body.pid ?? null, id: body.id });
      // The real route holds a waiting answer up to 15 s; a short pause keeps the client from spinning.
      if (answer.state === "waiting") await Bun.sleep(5);
      return Response.json(answer);
    }
    if (path.endsWith("/release")) return Response.json({ ok: broker.release(body.id ?? "") });
    if (path.endsWith("/renew")) return Response.json({ ok: broker.renew(body.id ?? "") });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { broker, fetchFn, dead, base: async () => "http://server.test" };
}

describe("acquireHeavySlotForCommand", () => {
  test("with the line full a heavy command waits, and starts as soon as the place frees", async () => {
    const s = server(1);
    const first = await acquireHeavySlotForCommand({ label: "tsc", base: s.base, fetchFn: s.fetchFn, maxWaitMs: 5_000 });
    expect(first).not.toBeNull();
    let started = false;
    const second = acquireHeavySlotForCommand({ label: "bun test", base: s.base, fetchFn: s.fetchFn, maxWaitMs: 5_000 }).then((l) => { started = true; return l; });
    await Bun.sleep(40);
    expect(started).toBe(false);
    expect(s.broker.status().waiting.map((w) => w.label)).toEqual(["bun test"]);
    first!.release();
    const lease = await second;
    expect(lease).not.toBeNull();
    expect(s.broker.status().held.map((h) => h.label)).toEqual(["bun test"]);
  });

  test("the place is tied to this process: the broker frees it when the process dies", async () => {
    const s = server(1);
    await acquireHeavySlotForCommand({ label: "tsc", base: s.base, fetchFn: s.fetchFn, maxWaitMs: 5_000 });
    expect(s.broker.status().held[0]?.pid).toBe(process.pid);
    s.dead.add(process.pid);
    expect(s.broker.request({ label: "next" }).state).toBe("granted");
  });

  test("a stop while waiting returns at once, and a place granted later is given back", async () => {
    const s = server(1);
    const first = await acquireHeavySlotForCommand({ label: "tsc", base: s.base, fetchFn: s.fetchFn, maxWaitMs: 5_000 });
    const stop = new AbortController();
    const waiting = acquireHeavySlotForCommand({ label: "eslint", base: s.base, fetchFn: s.fetchFn, maxWaitMs: 5_000, signal: stop.signal });
    await Bun.sleep(20);
    stop.abort();
    expect(await waiting).toBeNull();
    first!.release();
    await Bun.sleep(60);
    expect(s.broker.status().held).toHaveLength(0);
  });

  test("an unreachable server means the command just runs", async () => {
    expect(await acquireHeavySlotForCommand({ label: "tsc", base: async () => null, maxWaitMs: 5_000 })).toBeNull();
  });
});

describe("isHeavyCommand", () => {
  test("suites, type checks and lint are heavy; ls and git status are not", () => {
    for (const c of ["bun run typecheck", "bun test server/x.test.ts", "npx tsc --noEmit", "eslint .", "cargo test"]) expect(isHeavyCommand(c)).toBe(true);
    for (const c of ["ls -la", "git status", "tsc --lsp", "cat package.json"]) expect(isHeavyCommand(c)).toBe(false);
  });
});
