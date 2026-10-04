import type { AppContext, RouteHandler } from "../types";
import { markAttentionSeen } from "../attention/store";
import { isAttentionSubject, type AttentionSeenItem } from "../../shared/attention";

/** How many subjects one seen may name: the inbox lists tens, a runaway body must not become a runaway broadcast. */
const MAX_SEEN_ITEMS = 500;

/** The items of a seen, checked rather than trusted: the body comes from the network. */
export function parseSeenItems(body: unknown): AttentionSeenItem[] {
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return [];
  const out: AttentionSeenItem[] = [];
  for (const it of raw.slice(0, MAX_SEEN_ITEMS)) {
    if (!it || typeof it !== "object") continue;
    const { subject, epoch, turnAt } = it as { subject?: unknown; epoch?: unknown; turnAt?: unknown };
    if (typeof subject !== "string" || !isAttentionSubject(subject)) continue;
    if (typeof epoch !== "number" || !Number.isFinite(epoch)) continue;
    out.push({ subject, epoch, turnAt: typeof turnAt === "string" ? turnAt : null });
  }
  return out;
}

/**
 * THE SEEN DOOR (notifications-redesign, design section 6, ATTN-06):
 *
 *   POST /api/attention/seen  { items: [{ subject, epoch, turnAt }] }
 *
 * `epoch` and `turnAt` are what the client was SHOWING: an epoch born after,
 * or a turn closed after, stays lit. The door always answers with the rows and
 * always announces `attention:updated`, even when nothing changed. A guest
 * never reaches it: `/api/attention/` is not in the guest allowlist of
 * `lib/grants.ts`, and the store drops a guest's seen anyway.
 *
 * `POST /api/topics/:id/read` and `POST /api/notifications/seen` are aliases
 * while the old client exists (tasks.md 6.2 removes them).
 */
export function createAttentionRouter(ctx: Pick<AppContext, "json" | "readJSON">): RouteHandler {
  const { json, readJSON } = ctx;
  return async function attentionRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "POST" && pathname === "/api/attention/seen") {
      const items = parseSeenItems(await readJSON(req));
      if (items.length === 0) return json({ error: "items required: [{ subject, epoch, turnAt }]" }, 400);
      return json({ ok: true, rows: markAttentionSeen(items) });
    }
    return null;
  };
}
