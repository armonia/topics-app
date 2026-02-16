import type { AppContext, RouteHandler } from "../types";
import { getUsageToday, getUsageSummary, getUsageRange, getUsageForSession } from "../usage/store";

export function createUsageRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute } = ctx;

  return async function usageRouter(_req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    // GET /api/usage/today
    if (method === "GET" && pathname === "/api/usage/today") {
      return json(getUsageToday());
    }

    // GET /api/usage/summary
    if (method === "GET" && pathname === "/api/usage/summary") {
      return json(getUsageSummary());
    }

    // GET /api/usage/range?from=YYYY-MM-DD&to=YYYY-MM-DD
    if (method === "GET" && pathname === "/api/usage/range") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!from || !to) return json({ error: "from and to parameters required" }, 400);
      return json({ records: getUsageRange(from, to) });
    }

    // GET /api/usage/session/:sessionKey
    {
      const params = matchRoute(pathname, "/api/usage/session/:sessionKey");
      if (params && method === "GET") {
        return json({ records: getUsageForSession(decodeURIComponent(params.sessionKey)) });
      }
    }

    return null;
  };
}
