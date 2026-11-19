import type { AppContext, RouteHandler } from "../types";
import { getReasoningTranslationService } from "../reasoning-translation/default";

/**
 * POST /api/reasoning/translate  { text } -> { available, target, sentences: [{ source, text }] }
 *
 * The translation of a settled reasoning block, asked by the client when a
 * person opens a row (the live path travels on the WebSocket instead). Only the
 * sentences that were translated come back: the client swaps those in place and
 * leaves the rest as they are. `available: false` says no translator works on
 * this machine, and the client stops asking for a while.
 *
 * A block of any language is accepted; same-language and too-short text just
 * come back with no sentences.
 */

/** A reasoning block is a few thousand characters; anything past this is not one. */
const MAX_TEXT_CHARS = 100_000;

export function createReasoningTranslationRouter(
  ctx: AppContext,
  getService: typeof getReasoningTranslationService = getReasoningTranslationService,
): RouteHandler {
  const { json } = ctx;
  return async function reasoningTranslationRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/reasoning/translate" || method !== "POST") return null;
    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== "string" || body.text.length === 0 || body.text.length > MAX_TEXT_CHARS) {
      return json({ error: "text must be a non-empty string of at most 100000 characters" }, 400);
    }
    return json(await getService().translateText(body.text));
  };
}
