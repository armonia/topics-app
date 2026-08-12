import type { AppContext, RouteHandler } from "../types";
import { countUnseenNotifications, listNotifications, markNotificationsSeen } from "../db/notification-log";
import { recordAndAnnounce } from "../notification-registry";
import { parseNotificationInput } from "../../shared/notification-log";

/**
 * La CRONOLOGIA delle notifiche: leggerla, scriverci, segnarla vista.
 *
 * Tre rotte e nessuna magia:
 *   GET  /api/notifications           → le ultime righe + quante non viste
 *   POST /api/notifications           → registra una notifica MANDATA (banner)
 *   POST /api/notifications/seen      → segna viste (tutte fino a X, o puntuali)
 *
 * Il POST lo chiama il client dalla sua unica porta dei banner
 * (`useCompletionNotifier` → `fire`). Non è una "creazione di notifica": la
 * notifica è GIÀ partita, questa è la sua riga di registro. Per questo il
 * fallimento è silenzioso e la risposta dice solo se la riga era nuova.
 */
export function createNotificationsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;

  return async function notificationsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "GET" && pathname === "/api/notifications") {
      const limit = parseInt(url.searchParams.get("limit") || "0") || undefined;
      const before = url.searchParams.get("before") || undefined;
      return json({ rows: listNotifications({ limit, before }), unseen: countUnseenNotifications() });
    }

    if (method === "POST" && pathname === "/api/notifications") {
      const body = await readJSON(req);
      const input = parseNotificationInput(body);
      if (!input) return json({ error: "Invalid notification" }, 400);
      const row = recordAndAnnounce(input);
      return json({ ok: true, recorded: !!row, row, unseen: countUnseenNotifications() });
    }

    if (method === "POST" && pathname === "/api/notifications/seen") {
      const body = (await readJSON(req)) as { ids?: unknown; upTo?: unknown } | null;
      const ids = Array.isArray(body?.ids) ? body!.ids.filter((v): v is string => typeof v === "string") : undefined;
      const upTo = typeof body?.upTo === "string" ? body!.upTo : undefined;
      // Nessuno dei due → non è "segna tutto", è una chiamata malformata. Una
      // cronologia che si azzera per sbaglio è peggio di un errore 400.
      if (!ids?.length && !upTo) return json({ error: "ids or upTo required" }, 400);
      markNotificationsSeen({ ids, upTo });
      const unseen = countUnseenNotifications();
      // Il contatore vive su OGNI finestra: chi ha guardato la lista qui deve
      // spegnerlo anche là (gruppi staccati, telefono sulla stessa rete).
      ctx.broadcastToAll({ type: "notification:seen", unseen });
      return json({ ok: true, unseen });
    }

    return null;
  };
}

