/**
 * Generative views (GENUI-01): the store behind `show_view`.
 *
 *   POST /api/sessions/:sessionKey/views   body = the spec an agent sent
 *        -> 201 { id, path }   |   400 { error, errors[] } written for the agent
 *   GET  /api/views/:id                    -> { id, spec, topicId?, createdAt }
 *
 * WHY A FILE PER VIEW and not a table: a view is written once and never
 * updated, read by id only, and small. A migration would apply to the live DB
 * the moment the file lands (see CLAUDE.md), for a store that needs no query.
 * `data/views/<id>.json` sits next to `topics.db`, under the same writable root.
 *
 * Auth is the single gate every `/api/` request already passes
 * (`server/lib/auth-gate.ts`): no second gate here that could drift from it.
 * The spec is normalized HERE, with the same function the renderer uses, so a
 * stored view is always one the page can draw.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { resolveDataDir } from "../lib/data-dir";
import { normalizeViewSpec, parseViewSpec, VIEW_ID_RE, viewPath, type ViewSpec } from "../../shared/views";

export interface StoredView {
  id: string;
  spec: ViewSpec;
  topicId?: string;
  createdAt: string;
}

/** Hard cap on the request body: a view is data, not a page. */
const MAX_BODY_BYTES = 256 * 1024;

export function viewsDir(stateDir: string): string {
  return join(resolveDataDir(stateDir), "views");
}

export function readStoredView(dir: string, id: string): StoredView | null {
  if (!VIEW_ID_RE.test(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as StoredView;
    const spec = parseViewSpec(raw.spec);
    return spec ? { ...raw, spec } : null;
  } catch {
    return null;
  }
}

export function createViewsRouter(ctx: AppContext, opts: { dir?: string } = {}): RouteHandler {
  const { json, matchRoute, getTopicBySessionKey } = ctx;
  const dir = opts.dir ?? viewsDir(ctx.STATE_DIR);

  return async function viewsRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "POST") {
      const m = matchRoute(pathname, "/api/sessions/:sessionKey/views");
      if (!m) return null;
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_BODY_BYTES) return json({ error: `view too large (${len} bytes, max ${MAX_BODY_BYTES})` }, 413);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      const norm = normalizeViewSpec(body);
      if (!norm.ok) return json({ error: `invalid view: ${norm.errors.join("; ")}`, errors: norm.errors }, 400);
      const sessionKey = decodeURIComponent(m.sessionKey);
      const topicId = getTopicBySessionKey(sessionKey)?.id;
      const id = randomBytes(8).toString("hex");
      const stored: StoredView = { id, spec: norm.spec, ...(topicId ? { topicId } : {}), createdAt: new Date().toISOString() };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(stored));
      return json({ id, path: viewPath(id), spec: norm.spec }, 201);
    }

    if (method === "GET") {
      const m = matchRoute(pathname, "/api/views/:id");
      if (!m) return null;
      const view = readStoredView(dir, m.id);
      if (!view) return json({ error: "view not found" }, 404);
      return json(view);
    }
    return null;
  };
}
