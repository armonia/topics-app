/**
 * THE ONE DOOR for "what is this costing", per session and per project.
 *
 * Both numbers already existed and neither had a way out of the server: the
 * native runtime's per-session token totals lived in an in-memory registry only
 * the dispatcher could see (`providers/native-usage-registry.ts`), and the
 * per-project consumption existed only as a grouping nobody had written yet.
 * This router is the two of them, and nothing else.
 *
 * NOT THE SAME QUESTION AS `/api/context/cost`, which stays where it is: that
 * one reads every `messages` row of ONE session to answer "how much does the
 * next call cost". These answer "how much has been spent", for many at a time.
 */
import type { AppContext, RouteHandler } from "../types";
import { listNativeUsage } from "../providers/native-usage-registry";
import { unknownPricedModels } from "../usage/pricing";
import { projectUsage, type ProjectUsageResult } from "../usage/project-usage";
// THE ANSWER IS TYPED AT THE DOOR, not just described in a comment. The shape
// says the thing this route must never be read as - `absentMeansUnmeasured`,
// and a `cacheWrite1hTokens` that is a SUBSET and not another addend - so the
// annotation is what makes a field renamed in `shared/` a compile error here
// instead of a number that quietly stops arriving.
import type { SessionUsageResponse } from "../../shared/usage-shapes";

/**
 * The per-project aggregate is a GROUP BY over the whole `messages` table, and
 * that table is wide (`content`, `blocks` and `tool_calls` sit on the same row
 * as the usage columns, so the scan pulls overflow pages it does not need).
 * Measured on the live database, 23k messages and 3.8k tasks: 1.2 s on a
 * process's first call, 91 ms once the pages are warm, 24 ms for a 7-day
 * window. Cheap enough to ask for, far too expensive to poll - so a reading is
 * reused for a minute and `cachedAt` says how old the one you got is.
 *
 * The alternative would be a covering index, which is a migration - and a
 * migration file lands on the LIVE database seconds after it is saved. Not for
 * a panel that can read a value up to sixty seconds old.
 */
const PROJECT_TTL_MS = 60_000;

export function createUsageRouter(ctx: AppContext): RouteHandler {
  const { db, json } = ctx;

  let cached: { at: number; days: number | null; data: ProjectUsageResult } | null = null;

  return async function usageRouter(
    _req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {

    /**
     * GET /api/usage/sessions — token totals for EVERY live native session.
     *
     * One map read, no I/O, no database: safe to poll. The registry is capped
     * at 200 entries with eviction of the oldest, so a session that fell off
     * the end is ABSENT from `sessions` rather than present with zeros. Absent
     * means "this server has no measurement", never "it cost nothing" - the
     * same distinction `readNativeUsage` keeps by returning `null`.
     *
     * Deliberately NOT wired to the transcript reader that `getSessionUsage`
     * falls back to: that one opens multi-MB JSONL files, and a heavy probe
     * behind a polled route is how a panel starts costing more than what it
     * measures.
     */
    if (method === "GET" && pathname === "/api/usage/sessions") {
      const body: SessionUsageResponse = {
        sessions: listNativeUsage().map((u) => ({
          sessionKey: u.sessionKey,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          cacheWrite1hTokens: u.cacheWrite1hTokens,
          cacheReadTokens: u.cacheReadTokens,
          billableTokens: u.billableTokens,
        })),
        source: "native-runtime",
        absentMeansUnmeasured: true,
      };
      return json(body);
    }

    // GET /api/usage/projects?range=7d|30d|all
    if (method === "GET" && pathname === "/api/usage/projects") {
      const range = url.searchParams.get("range") || "all";
      const days = range === "1d" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;

      if (cached && cached.days === days && Date.now() - cached.at < PROJECT_TTL_MS) {
        return json({ range, cachedAt: new Date(cached.at).toISOString(), ...cached.data });
      }

      try {
        // `unpricedModels` comes from the SAME process-wide registry
        // `/api/system/status` reports, so a client that shows both cannot see
        // two different answers to "is anything running unpriced".
        const data = projectUsage(db, { days, unpricedModels: unknownPricedModels() });
        cached = { at: Date.now(), days, data };
        return json({ range, cachedAt: new Date(cached.at).toISOString(), ...data });
      } catch (err: any) {
        console.error("[Usage] project aggregate failed:", err);
        return ctx.errorResponse(500, err?.message || "Failed to compute project usage");
      }
    }

    return null;
  };
}
