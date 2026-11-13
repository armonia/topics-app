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
import type { AppContext, RouteHandler } from "../types";
import type { HeavySlotBroker } from "../services/heavy-slot";
import { sharedHeavySlotBroker } from "../services/heavy-slot-default";

const HOLD_MS = 15_000;
const STEP_MS = 400;

export function createHeavySlotRouter(ctx: AppContext, broker: HeavySlotBroker = sharedHeavySlotBroker()): RouteHandler {
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
