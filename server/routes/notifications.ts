import type { AppContext, RouteHandler } from "../types";
import { listNotifications, unseenSnapshot } from "../db/notification-log";
import { markAllNotificationsSeen, markNotificationRowsSeen, markTopicSeen } from "../subject-seen";
import { markTargetSeenAndAnnounce, recordAndAnnounce } from "../notification-registry";
import { parseNotificationInput } from "../../shared/notification-log";
import { groupKeysOfNotifications } from "../db/notification-log";
import { createAttentionRouter } from "./attention";
import { markAttentionSeen, seenItemNow } from "../attention/store";
import { isAttentionSubject } from "../../shared/attention";

/**
 * La CRONOLOGIA delle notifiche: leggerla, scriverci, segnarla vista.
 *
 * Tre rotte e nessuna magia:
 *   GET  /api/notifications           → le ultime righe + quante non viste
 *   POST /api/notifications           → registra una notifica MANDATA (banner)
 *   POST /api/notifications/seen      → segna viste (fino a X, puntuali, o per bersaglio)
 *
 * Il POST lo chiama il client dalla sua unica porta dei banner
 * (`useCompletionNotifier` → `fire`). Non è una "creazione di notifica": la
 * notifica è GIÀ partita, questa è la sua riga di registro. Per questo il
 * fallimento è silenzioso e la risposta dice solo se la riga era nuova.
 */
export function createNotificationsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;
  // The seen door needs the unread store: a chat's notification seen here is
  // the chat seen, exactly as if it had been opened.
  const seenDeps = { loadUnread: ctx.loadUnread, saveUnreadEntries: ctx.saveUnreadEntries, broadcastToAll: ctx.broadcastToAll };
  // The seen door of the attention state lives in its own module and is
  // mounted here, next to the doors it replaces (`./attention.ts`).
  const attentionRouter = createAttentionRouter(ctx);
  /** The old doors are aliases of the new one: what they name is seen NOW. */
  const seeNow = (subjects: readonly string[]) => {
    const items = [...new Set(subjects)].filter(isAttentionSubject).map(seenItemNow);
    if (items.length) markAttentionSeen(items);
  };

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
      const row = recordAndAnnounce(input);
      return json({ ok: true, recorded: !!row, row, ...unseenSnapshot() });
    }

    if (method === "POST" && pathname === "/api/notifications/seen") {
      const body = (await readJSON(req)) as
        { ids?: unknown; upTo?: unknown; subjects?: unknown; targetKind?: unknown; targetId?: unknown } | null;
      const ids = Array.isArray(body?.ids) ? body!.ids.filter((v): v is string => typeof v === "string") : undefined;
      const upTo = typeof body?.upTo === "string" ? body!.upTo : undefined;
      // The mark all names what the panel listed beyond its rows; only those
      // are cleared (`markAllNotificationsSeen`).
      const subjects = Array.isArray(body?.subjects)
        ? body!.subjects.filter((v): v is string => typeof v === "string")
        : undefined;
      // Third form: BY TARGET. Opening the terminal that finished is the
      // natural gesture by which a person says "I have seen it", and until now
      // the registry did not know - only the history panel cleared it, and
      // nobody goes there on purpose. Extending this route instead of adding a
      // new one: same verb, different selector.
      const targetKind = typeof body?.targetKind === "string" ? body!.targetKind : undefined;
      const targetId = typeof body?.targetId === "string" ? body!.targetId : undefined;
      if (targetKind && targetId) {
        // A chat goes through the same door as opening it (unread + rows);
        // anything else announces by itself only if it cleared something.
        if (targetKind === "topic") markTopicSeen(seenDeps, targetId);
        else markTargetSeenAndAnnounce(targetKind, targetId);
        seeNow([`${targetKind}:${targetId}`]);
        return json({ ok: true, ...unseenSnapshot() });
      }
      // Nessuno dei due → non è "segna tutto", è una chiamata malformata. Una
      // cronologia che si azzera per sbaglio è peggio di un errore 400.
      if (!ids?.length && !upTo && !subjects?.length) return json({ error: "ids, upTo, subjects or target required" }, 400);
      // Both doors broadcast `notification:seen` to EVERY window, with the
      // subjects they cleared: whoever looked at the list here must see it
      // switch off there too (detached groups, a phone on the same network).
      let snapshot = unseenSnapshot();
      // The subjects behind the rows, read before the rows change.
      const rowSubjects = ids?.length ? groupKeysOfNotifications(ids) : [];
      if (upTo || subjects?.length) snapshot = markAllNotificationsSeen(seenDeps, { upTo, subjects });
      if (ids?.length) snapshot = markNotificationRowsSeen(seenDeps, ids);
      seeNow([...(subjects ?? []), ...rowSubjects]);
      return json({ ok: true, ...snapshot });
    }

    return null;
  };
}

