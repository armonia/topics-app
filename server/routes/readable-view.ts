import type { AppContext, RouteHandler } from "../types";
import { getDefaultProvider } from "../providers";
import { completeWith, readableViewFallback, READABLE_VIEW_MODEL, type FallbackDeps } from "../services/readable-view-fallback";

/**
 * POST /api/readable-view  { toolName, value, model? } -> { view: ReadableView | null }
 *
 * The model fallback for a tool result the client's pure matcher could not
 * place. One model call per never-seen SHAPE (cached by signature in
 * `readable_view_cache`), never one per result. `view: null` means no view is
 * possible and the client keeps the original text, which it shows meanwhile.
 */

/** A tool result larger than this is not worth sending to a model for a layout. */
const MAX_VALUE_CHARS = 200_000;

export function createReadableViewRouter(
  ctx: AppContext,
  getComplete: () => FallbackDeps["complete"] | null = () => null,
): RouteHandler {
  const { json } = ctx;
  return async function readableViewRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/readable-view" || method !== "POST") return null;
    const body = (await req.json().catch(() => null)) as { toolName?: unknown; value?: unknown; model?: unknown } | null;
    if (typeof body?.toolName !== "string" || body.toolName.length === 0 || body.toolName.length > 200 || body.value === undefined) {
      return json({ error: "toolName and value are required" }, 400);
    }
    if (JSON.stringify(body.value).length > MAX_VALUE_CHARS) return json({ view: null });
    const model = typeof body.model === "string" && /^[\w.:-]{1,80}$/.test(body.model) ? body.model : READABLE_VIEW_MODEL;
    let complete = getComplete();
    if (!complete) {
      try {
        complete = completeWith(getDefaultProvider(), model);
      } catch {
        return json({ view: null });
      }
    }
    const view = await readableViewFallback({ db: ctx.db, complete }, body.toolName, body.value);
    return json({ view });
  };
}
