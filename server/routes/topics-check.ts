/**
 * `GET /api/topics-check` -- the three voices of the self-check round, read
 * from the samples the round keeps (never a fresh measurement: asking costs one
 * read of a small table).
 */
import type { AppContext, RouteHandler } from "../types";
import { createTopicsCheck } from "../services/topics-check";
import { readLatestVerdict } from "../services/topics-check-daily";

export function createTopicsCheckRouter(ctx: AppContext, opts: { now?: () => number } = {}): RouteHandler {
  const round = createTopicsCheck({ db: ctx.db, now: opts.now });
  return async function topicsCheckRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/topics-check" || method !== "GET") return null;
    return ctx.json({ ...round.current(), daily: readLatestVerdict(ctx.db) });
  };
}
