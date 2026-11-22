/**
 * `GET /api/topics-check` -- the three voices of the self-check round, read
 * from the samples the round keeps (never a fresh measurement: asking costs one
 * read of a small table).
 */
import type { AppContext, RouteHandler } from "../types";
import { createTopicsCheck } from "../services/topics-check";
import { dayKey, readLatestVerdict, type DailyVerdict } from "../services/topics-check-daily";

/** The newest daily verdict, marked `old` when it is not today's; a broken row never takes the endpoint down. */
function readDaily(ctx: AppContext, now: number): (DailyVerdict & { old: boolean }) | null {
  try {
    const v = readLatestVerdict(ctx.db);
    return v ? { ...v, old: v.day !== dayKey(now) } : null;
  } catch {
    return null;
  }
}

export function createTopicsCheckRouter(ctx: AppContext, opts: { now?: () => number } = {}): RouteHandler {
  const round = createTopicsCheck({ db: ctx.db, now: opts.now });
  return async function topicsCheckRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/topics-check" || method !== "GET") return null;
    return ctx.json({ ...round.current(), daily: readDaily(ctx, (opts.now ?? Date.now)()) });
  };
}
