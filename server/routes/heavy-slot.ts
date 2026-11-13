/**
 * `POST /api/heavy-slot/acquire`  -- ask for a place; answers granted or waiting.
 * `POST /api/heavy-slot/renew`    -- keep a lease alive.
 * `POST /api/heavy-slot/release`  -- free it.
 * `GET  /api/heavy-slot`          -- who holds and who waits.
 *
 * Acquire holds the request open for a few seconds when the answer is "waiting",
 * so a queued caller is admitted within one step of a slot freeing instead of
 * sleeping a whole interval. The client asks again with the id it was given.
 */
import os from "node:os";
import type { AppContext, RouteHandler } from "../types";
import { createHeavySlotBroker, type HeavySlotBroker } from "../services/heavy-slot";
import { availableMemGB } from "../services/dispatch-capacity";
import { machineCpuPct } from "../lib/machine-cpu";

const HOLD_MS = 15_000;
const STEP_MS = 400;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function createDefaultHeavySlotBroker(): HeavySlotBroker {
  return createHeavySlotBroker({
    now: () => Date.now(),
    alive: pidAlive,
    pressure: () => {
      let mem: number | null = null;
      try { mem = availableMemGB(); } catch { /* not measured */ }
      // Off macOS the vm_stat probe is absent: fall back to what the OS calls free.
      mem ??= os.freemem() / 1e9;
      let cpu: number | null = null;
      try { cpu = machineCpuPct(null); } catch { /* not measured */ }
      return { availableMemGB: mem, cpuPct: cpu };
    },
  });
}

export function createHeavySlotRouter(ctx: AppContext, broker: HeavySlotBroker = createDefaultHeavySlotBroker()): RouteHandler {
  const { json } = ctx;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return async function heavySlotRouter(req, _url, pathname, method) {
    if (!pathname.startsWith("/api/heavy-slot")) return null;
    if (pathname === "/api/heavy-slot" && method === "GET") return json(broker.status());
    if (method !== "POST") return null;

    let body: { label?: unknown; pid?: unknown; id?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty body */ }
    const id = typeof body.id === "string" && body.id ? body.id : undefined;

    if (pathname === "/api/heavy-slot/acquire") {
      const label = typeof body.label === "string" ? body.label.slice(0, 200) : "heavy";
      const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
      let answer = broker.request({ label, pid, id });
      const until = Date.now() + HOLD_MS;
      while (answer.state === "waiting" && Date.now() < until) {
        await sleep(STEP_MS);
        answer = broker.request({ label, pid, id: answer.id });
      }
      return json(answer);
    }
    if (pathname === "/api/heavy-slot/renew") return json({ ok: id ? broker.renew(id) : false });
    if (pathname === "/api/heavy-slot/release") return json({ ok: id ? broker.release(id) : false });
    return null;
  };
}
