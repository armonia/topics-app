/**
 * POST /api/client-trace: the client's `[pane-attach]` lines, written into this
 * process's log.
 *
 * WHY THE SERVER LOG. The desktop client is a WKWebView, and nobody reads its
 * console after the fact. On 24/09 (card c5c1c68f) a project browser pane
 * closed its socket two seconds after a reconnect, and fourteen minutes later
 * `open_browser_pane` found nothing to attach. The only record anyone could read
 * a day later was this log, and it had the server's side alone. The client now
 * traces every decision between an opening and an attached pane
 * (`client/src/lib/paneAttachTrace.ts`), and this route puts those lines next to
 * the server's own `[WS][browser]` ones, where the next incident gets read.
 *
 * Log lines, not storage: nothing is kept, and a malformed batch is dropped
 * whole. The shape is bounded (events per batch, characters per field) because
 * every event becomes a line of a file that is read by hand. Guests never reach
 * it: `/api/client-trace` is not in the guest allowlist (`server/lib/grants.ts`).
 */
import type { AppContext, RouteHandler } from "../types";

const MAX_EVENTS = 50;
const MAX_EVENT_CHARS = 80;
const MAX_FIELDS_CHARS = 600;

/** Only what a log line can carry unchanged: printable ASCII. */
function printable(value: string, max: number): string {
  const clean = value.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * The log lines of one batch, or null when the body is not a batch.
 *
 * `clientId` is the tab id the client sends as `X-Client-Id`, so the lines of
 * one window can be told apart from another's. `at` is the client's clock,
 * printed as such: a batch that waited out a server restart arrives late, and
 * the order that matters is the one on the client.
 */
export function formatClientTraceLines(body: unknown, clientId: string | null): string[] | null {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) return null;
  const who = clientId ? printable(clientId, 16) : "?";
  const lines: string[] = [];
  for (const raw of events) {
    const e = raw as { at?: unknown; event?: unknown; fields?: unknown } | null;
    if (!e || typeof e.event !== "string" || typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
    let fields = "";
    if (e.fields !== undefined) {
      try {
        fields = printable(JSON.stringify(e.fields) ?? "", MAX_FIELDS_CHARS);
      } catch {
        fields = "(unserializable)";
      }
    }
    const at = new Date(e.at);
    const when = Number.isNaN(at.getTime()) ? "?" : at.toISOString();
    lines.push(`[client-trace] ${when} ${who} pane-attach ${printable(e.event, MAX_EVENT_CHARS)} ${fields}`.trimEnd());
  }
  return lines;
}

export function createClientTraceRouter(ctx: AppContext, log: (line: string) => void = console.log): RouteHandler {
  const { json, readJSON } = ctx;
  return async function clientTraceRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/client-trace") return null;
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const lines = formatClientTraceLines(await readJSON(req), req.headers.get("x-client-id"));
    if (!lines) return json({ error: "Expected { events: [{ at, event, fields }] }, 1 to 50 events" }, 400);
    for (const line of lines) log(line);
    return new Response(null, { status: 204 });
  };
}
