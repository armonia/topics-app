import type { AppContext, RouteHandler } from "../types";
import type { ActivityMonitor } from "../activity-monitor";

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
      const topicId = url.searchParams.get("topicId");
      let events = monitor.getRecent(Math.min(limit, 500));
      // Filtering by topicId is a future feature (requires sessionKey mapping)
      return json({ events });
    }

    return null;
  };
}
