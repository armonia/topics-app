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
 * whole. Everything is bounded, because every event becomes a line of a file
 * that is read by hand: the body (64 KB, refused before it is read), the batch
 * (50 events), each field (cut BEFORE it is escaped), and the lines per minute
 * across all clients. Guests never reach it: `/api/client-trace` is not in the
 * guest allowlist (`server/lib/grants.ts`).
 */
import type { AppContext, RouteHandler } from "../types";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 50;
const MAX_EVENT_CHARS = 80;
const MAX_FIELDS_CHARS = 600;
/**
 * A browser opening traces a handful of lines, a reload a few dozen. Measured
 * before this cap: 200 concurrent batches wrote 10,053 lines in 284 ms. Past it
 * the lines are counted, and the count is written once, with the minute it is
 * about, before the next batch that gets through.
 */
const MAX_LINES_PER_MINUTE = 600;

/**
 * What a log line can carry. Cut to `max` characters first, so the work is
 * bounded whatever came in. Then printable ASCII stays as it is, and any other
 * character becomes a `\uXXXX` escape, so an accented path stays readable. The
 * ones that could split a line or change its colours (C0 and C1 controls,
 * U+007F, U+0085, U+2028, U+2029: newline, CR and ANSI among them) become "?".
 */
function printable(value: string, max: number): string {
  const cut = value.length > max ? value.slice(0, max) : value;
  let out = "";
  for (let i = 0; i < cut.length; i++) {
    const c = cut.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) out += cut[i];
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029) out += "?";
    else out += `\\u${c.toString(16).padStart(4, "0")}`;
  }
  return cut.length < value.length ? `${out}...` : out;
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

/**
 * The body as text, or null past `max` bytes. A declared length over the cap is
 * refused without reading a byte; a body without one (chunked) is read only up
 * to the cap.
 */
async function readCappedText(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function createClientTraceRouter(
  ctx: AppContext,
  log: (line: string) => void = console.log,
  now: () => number = Date.now,
): RouteHandler {
  const { json } = ctx;
  let windowStart = 0;
  let windowLines = 0;
  let dropped = 0;

  /** How many of `n` lines this minute still admits; the rest are counted. */
  const admit = (n: number): number => {
    const t = now();
    if (t - windowStart >= 60_000) {
      // Said by the first batch AFTER the window, which can come hours later:
      // so the line names the minute it is about, not "the last minute".
      if (dropped > 0) {
        log(`[client-trace] ${dropped} line(s) dropped in the minute from ${new Date(windowStart).toISOString()} (cap ${MAX_LINES_PER_MINUTE}/min)`);
      }
      windowStart = t;
      windowLines = 0;
      dropped = 0;
    }
    const room = Math.max(0, MAX_LINES_PER_MINUTE - windowLines);
    const taken = Math.min(n, room);
    windowLines += taken;
    dropped += n - taken;
    return taken;
  };

  return async function clientTraceRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/client-trace") return null;
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const text = await readCappedText(req, MAX_BODY_BYTES);
    if (text === null) return json({ error: `Body over ${MAX_BODY_BYTES} bytes` }, 413);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const lines = formatClientTraceLines(body, req.headers.get("x-client-id"));
    if (!lines) return json({ error: "Expected { events: [{ at, event, fields }] }, 1 to 50 events" }, 400);
    const taken = admit(lines.length);
    for (let i = 0; i < taken; i++) log(lines[i]!);
    return new Response(null, { status: 204 });
  };
}
