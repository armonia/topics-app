import type { AppContext, RouteHandler } from "../types";
import { getDefaultProvider } from "../providers";
import { completeWith, readableViewFallback, READABLE_VIEW_MODEL, type FallbackDeps } from "../services/readable-view-fallback";
import { readReadableViewSettings, writeReadableViewSettings } from "../services/readable-view-settings";
import { toolPhraseFallback } from "../services/tool-phrase-fallback";
import { viewChunks } from "../../shared/readable-view";

/**
 * POST /api/readable-view  { toolName, value } -> NDJSON: `{"view":…}` lines, each
 * a fuller layout than the one before, then `{"done":true}`. A result with no
 * view possible is just `{"done":true}` and the client keeps the original text.
 *
 * The model fallback for a tool result the client's pure matcher could not
 * place. One model call per never-seen SHAPE (cached by signature in
 * `readable_view_cache`), never one per result. The model and the on/off
 * switch come from `readable_view_settings` on the server, never from the
 * client's request.
 *
 * POST /api/tool-phrase  { toolName, argKeys } -> { phrase: {text, category} | null }
 * GET|PUT /api/readable-view/settings  { fallbackEnabled, model }
 */

/** A tool result larger than this is not worth sending to a model for a layout. */
const MAX_VALUE_CHARS = 200_000;
const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" };

/** One line per flush, so the client reads each layout as it comes instead of one buffered body. */
function ndjson(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next >= lines.length) return controller.close();
      controller.enqueue(encoder.encode(`${JSON.stringify(lines[next++])}\n`));
      await new Promise((r) => setTimeout(r, 0));
    },
  });
  return new Response(body, { headers: NDJSON });
}

export function createReadableViewRouter(
  ctx: AppContext,
  getComplete: () => FallbackDeps["complete"] | null = () => null,
): RouteHandler {
  const { json } = ctx;
  function completeFor(model: string): FallbackDeps["complete"] | null {
    const injected = getComplete();
    if (injected) return injected;
    try {
      return completeWith(getDefaultProvider(), model || READABLE_VIEW_MODEL);
    } catch {
      return null;
    }
  }
  return async function readableViewRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname === "/api/readable-view/settings") {
      if (method === "GET") return json(readReadableViewSettings(ctx.db));
      if (method === "PUT") {
        const next = writeReadableViewSettings(ctx.db, await req.json().catch(() => null));
        return next ? json(next) : json({ error: "invalid settings" }, 400);
      }
      return null;
    }
    if (pathname === "/api/tool-phrase" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { toolName?: unknown; argKeys?: unknown } | null;
      if (typeof body?.toolName !== "string" || !body.toolName || body.toolName.length > 200) return json({ error: "toolName is required" }, 400);
      const argKeys = Array.isArray(body.argKeys) ? body.argKeys.filter((k): k is string => typeof k === "string").slice(0, 20) : [];
      const settings = readReadableViewSettings(ctx.db);
      const complete = settings.fallbackEnabled ? completeFor(settings.model) : null;
      if (!complete) return json({ phrase: null });
      return json({ phrase: await toolPhraseFallback({ db: ctx.db, complete }, body.toolName, argKeys) });
    }
    if (pathname !== "/api/readable-view" || method !== "POST") return null;
    const body = (await req.json().catch(() => null)) as { toolName?: unknown; value?: unknown } | null;
    if (typeof body?.toolName !== "string" || body.toolName.length === 0 || body.toolName.length > 200 || body.value === undefined) {
      return json({ error: "toolName and value are required" }, 400);
    }
    if (JSON.stringify(body.value).length > MAX_VALUE_CHARS) return ndjson([{ done: true }]);
    const settings = readReadableViewSettings(ctx.db);
    const complete = settings.fallbackEnabled ? completeFor(settings.model) : null;
    if (!complete) return ndjson([{ done: true }]);
    const view = await readableViewFallback({ db: ctx.db, complete }, body.toolName, body.value);
    return ndjson([...(view ? viewChunks(view).map((v) => ({ view: v })) : []), { done: true }]);
  };
}
