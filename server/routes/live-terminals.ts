/**
 * Routes — `/api/live-terminals`: ogni terminale vivo sul Mac, dentro e fuori Topics.
 *
 *   GET  /api/live-terminals                 → { terminals, generatedAt }
 *   GET  /api/live-terminals/:id/screen      → { id, text }
 *   POST /api/live-terminals/:id/send        { text, enter? = true } → { ok }
 *
 * `:id` è quello della lista, URL-encoded (`tmux:%258`, `terminal:ttys004`,
 * `topics:<uuid>`). Vedi `lib/live-terminals.ts`.
 *
 * AUTORIZZAZIONE. Scrivere qui è scrivere in un terminale, cioè eseguire codice.
 * Le rotte passano dal cancello globale (`auth-gate`: host, origine, dispositivo
 * appaiato), lo stesso che già protegge `POST /api/terminal/sessions`, che lancia
 * un comando qualunque. La tendina della UI e il telefono passano da lì; un
 * agente sul Mac entra da loopback come per il resto delle API.
 */
import type { AppContext, RouteHandler } from "../types";
import type { LiveTerminalsService } from "../lib/live-terminals";

/** Un messaggio più lungo di così non è una cosa da scrivere in un prompt. */
const MAX_SEND_CHARS = 16_000;

export function createLiveTerminalsRouter(ctx: AppContext, service: LiveTerminalsService): RouteHandler {
  const { json, errorResponse, readJSON } = ctx;

  return async function liveTerminalsRouter(req, url, pathname, method) {
    if (!pathname.startsWith("/api/live-terminals")) return null;

    if (method === "GET" && pathname === "/api/live-terminals") {
      const terminals = await service.list({ force: url.searchParams.get("fresh") === "1" });
      return json({ terminals, generatedAt: new Date().toISOString() });
    }

    const m = pathname.match(/^\/api\/live-terminals\/([^/]+)\/(screen|send)$/);
    if (!m) return null;
    let id: string;
    try { id = decodeURIComponent(m[1]); } catch { return errorResponse(400, "bad id"); }

    if (m[2] === "screen" && method === "GET") {
      const screen = await service.screen(id);
      if (!screen) return errorResponse(404, "terminal not found");
      return json(screen);
    }

    if (m[2] === "send" && method === "POST") {
      const body = await readJSON(req).catch(() => ({}));
      const text = typeof body?.text === "string" ? body.text : "";
      const enter = body?.enter !== false;
      if (!text && !enter) return errorResponse(400, "nothing to send");
      if (text.length > MAX_SEND_CHARS) return errorResponse(413, "text too long");
      const ok = await service.send(id, text, { enter });
      if (!ok) return errorResponse(404, "terminal not found");
      return json({ ok: true });
    }
    return null;
  };
}
