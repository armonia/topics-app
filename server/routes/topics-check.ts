/**
 * `GET /api/topics-check` -- the three voices of the self-check round, read
 * from the samples the round keeps (never a fresh measurement: asking costs one
 * read of a small table).
 */
import type { AppContext, RouteHandler } from "../types";
import { createTopicsCheck, readSamples, roundState } from "../services/topics-check";

export function createTopicsCheckRouter(ctx: AppContext): RouteHandler {
  const round = createTopicsCheck({ db: ctx.db });
  return async function topicsCheckRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/topics-check" || method !== "GET") return null;
    const samples = readSamples(ctx.db);
    return ctx.json({ at: samples.at(-1)?.at ?? null, ...roundState(samples, Date.now()), voices: round.current() });
  };
}
