import type { AppContext, RouteHandler } from "../types";
import { listNotifications, unseenSnapshot } from "../db/notification-log";
import { recordNotificationRow } from "../notification-registry";
import { parseNotificationInput } from "../../shared/notification-log";
import { createAttentionRouter } from "./attention";

/**
 * THE NOTIFICATION HISTORY: reading it, writing to it.
 *
 *   GET  /api/notifications       → the latest rows + how many are unseen
 *   POST /api/notifications       → records a notification row
 *
 * The seen has one door, `POST /api/attention/seen` (`./attention.ts`), mounted
 * here next to the history it marks. The old doors that aliased it
 * (`POST /api/notifications/seen`, `POST /api/topics/:id/read`) are gone with
 * the client that called them (notifications-redesign, tasks.md 6.2).
 *
 * The rows of the attention subjects are written by the attention store, not
 * by this POST; it stays the log's public door (a failed write is silent, and
 * the answer only says whether the row was new).
 */
export function createNotificationsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;
  const attentionRouter = createAttentionRouter(ctx);

  return async function notificationsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    const attention = await attentionRouter(req, url, pathname, method);
    if (attention) return attention;
    if (method === "GET" && pathname === "/api/notifications") {
      const limit = parseInt(url.searchParams.get("limit") || "0") || undefined;
      const before = url.searchParams.get("before") || undefined;
      return json({ rows: listNotifications({ limit, before }), ...unseenSnapshot() });
    }

    if (method === "POST" && pathname === "/api/notifications") {
      const body = await readJSON(req);
      const input = parseNotificationInput(body);
      if (!input) return json({ error: "Invalid notification" }, 400);
      const row = recordNotificationRow(input);
      return json({ ok: true, recorded: !!row, row, ...unseenSnapshot() });
    }

    return null;
  };
}
