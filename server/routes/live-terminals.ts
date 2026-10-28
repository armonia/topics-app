/**
 * Routes — `/api/live-terminals`: every live terminal on the Mac, inside and outside Topics.
 *
 *   GET  /api/live-terminals                 → { terminals, generatedAt }
 *   GET  /api/live-terminals/:id/screen      → { id, text }
 *   POST /api/live-terminals/:id/send        { text, enter? = true } → { ok }
 *                                            404 terminale sparito · 422 terminale che non accetta quell'invio
 *
 * `:id` is the listed one, URL-encoded (`tmux:%258`, `terminal:ttys004`,
 * `topics:<uuid>`). See `lib/live-terminals.ts`.
 *
 * AUTHORIZATION. Writing here is writing into a terminal, i.e. running code.
 * The routes go through the global gate (`auth-gate`: host, origin, paired
 * device), the same one already guarding `POST /api/terminal/sessions`, which
 * launches any command. The UI menu and the phone go through it; an
 * agent on the Mac enters via loopback like for the rest of the APIs.
 */
import type { AppContext, RouteHandler } from "../types";
import { SendRefusedError, type LiveTerminalsService } from "../lib/live-terminals";

/** Anything longer than this is not something to type into a prompt. */
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
      let ok: boolean;
      try {
        ok = await service.send(id, text, { enter });
      } catch (err) {
        // Il terminale c'è ma rifiuta l'invio: non è «sparito», chi scrive deve saperlo.
        if (err instanceof SendRefusedError) return errorResponse(422, err.message);
        throw err;
      }
      if (!ok) return errorResponse(404, "terminal not found");
      return json({ ok: true });
    }
    return null;
  };
}
