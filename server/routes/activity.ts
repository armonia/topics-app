import type { AppContext, RouteHandler } from "../types";
import { listActivity, type ActivityLevel } from "../db/activity-log";

/**
 * Activity LOG (audit trail), not a feed.
 *
 * The live Activity feed — an SSE stream fed by `ActivityMonitor`, which tailed
 * OpenClaw's gateway log files under /tmp/openclaw — is gone: OpenClaw is
 * dismissed, and everything that stream tried to say is already visible on the
 * tabs themselves (a session working, a turn finished, an attention badge).
 * What stays is the DURABLE part: the `activity_log` table the chat routes
 * write to, readable here for forensics.
 */
export function createActivityRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

  return async function activityRouter(_req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    // Query the persisted activity_log table (audit trail).
    // Supports filtering by level, category, sessionKey, and since (ISO timestamp).
    if (method === "GET" && pathname === "/api/activity/log") {
      const levelParam = url.searchParams.get("level");
      const validLevels: ActivityLevel[] = ["debug", "info", "warn", "error"];
      const level = levelParam && (validLevels as string[]).includes(levelParam)
        ? (levelParam as ActivityLevel)
        : undefined;
      const category = url.searchParams.get("category") || undefined;
      const sessionKey = url.searchParams.get("sessionKey") || undefined;
      const since = url.searchParams.get("since") || undefined;
      const limit = parseInt(url.searchParams.get("limit") || "200");
      const rows = listActivity({ level, category, sessionKey, since, limit });
      return json({ rows });
    }

    return null;
  };
}
