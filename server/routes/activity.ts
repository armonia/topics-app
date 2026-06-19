import type { AppContext, RouteHandler } from "../types";
import type { ActivityMonitor } from "../activity-monitor";
import { listActivity, type ActivityLevel } from "../db/activity-log";

export function createActivityRouter(ctx: AppContext, monitor: ActivityMonitor): RouteHandler {
  const { json, matchRoute } = ctx;

  return async function activityRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // SSE stream: GET /api/activity/stream
    if (method === "GET" && pathname === "/api/activity/stream") {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        start(controller) {
          let lastEventTime = Date.now();

          // Send recent events as initial batch
          const recent = monitor.getRecent(100);
          const initPayload = JSON.stringify({ type: "init", events: recent });
          controller.enqueue(encoder.encode(`data: ${initPayload}\n\n`));

          // Subscribe to new events
          const unsub = monitor.subscribe((events) => {
            try {
              lastEventTime = Date.now();
              const payload = JSON.stringify({ type: "events", events });
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            } catch {
              // Controller may be closed
            }
          });

          // Conditional keep-alive: only ping if no event sent in last 25s
          const keepAlive = setInterval(() => {
            try {
              if (Date.now() - lastEventTime >= 25000) {
                controller.enqueue(encoder.encode(`: keepalive\n\n`));
              }
            } catch {
              clearInterval(keepAlive);
            }
          }, 30000);

          // Clean up on abort
          req.signal.addEventListener("abort", () => {
            unsub();
            clearInterval(keepAlive);
            try { controller.close(); } catch {}
          });
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // REST: GET /api/activity/recent
    if (method === "GET" && pathname === "/api/activity/recent") {
      const limit = parseInt(url.searchParams.get("limit") || "200");
      return json({ events: monitor.getRecent(Math.min(limit, 500)) });
    }

    // REST: GET /api/activity (alias)
    if (method === "GET" && pathname === "/api/activity") {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const events = monitor.getRecent(Math.min(limit, 500));
      return json({ events });
    }

    // Query persisted activity_log table (audit trail, not live monitor stream).
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
