/**
 * Generative views (GENUI-01): the store behind `show_view`.
 *
 *   POST /api/sessions/:sessionKey/views   body = the spec an agent sent
 *        -> 201 { id, path }   |   400 { error, errors[] } written for the agent
 *   GET  /api/views/:id                    -> { id, spec, topicId?, createdAt }
 *   GET  /api/views/:id/app?lang=it|en     -> the view as an MCP Apps document (GENUI-08)
 *   GET  /api/views?limit=N                -> the newest views, for `resources/list`
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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { resolveDataDir } from "../lib/data-dir";
import { normalizeViewSpec, parseViewSpec, VIEW_ID_RE, viewPath, type ViewSpec } from "../../shared/views";
import { MCP_APP_MIME, documentOf, renderViewFragment, viewResourceUri, type ViewLanguage } from "../views/view-html";

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

/** What an MCP Apps host needs to show a view: the document and the origins it loads images from. */
export interface ViewApp {
  uri: string;
  mimeType: string;
  /** The whole document (`resources/read`), or only the view's markup for the generic app to inject. */
  html: string;
  /** Goes to the resource's `_meta.ui.csp.resourceDomains`: without it a host's CSP blocks the photos. */
  resourceDomains: string[];
}

const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
/** Per photo and in all: a local photo travels INSIDE the document (an external host cannot reach /api/media). */
const INLINE_MAX_BYTES = 400 * 1024;
const INLINE_BUDGET_BYTES = 3 * 1024 * 1024;

/**
 * The view as one document for an external host. A photo on https stays a URL
 * and its origin is declared; a local photo becomes a `data:` URI, only inside
 * the allowlist `/api/media` uses and within a size budget, else it is left
 * out (the card still reads without it).
 */
export function viewApp(
  view: StoredView,
  opts: { origin: string; language?: ViewLanguage; isPathAllowed: (p: string) => boolean; fragment?: boolean },
): ViewApp {
  const domains = new Set<string>();
  let budget = INLINE_BUDGET_BYTES;
  const imageUrl = (src: string): string | undefined => {
    if (/^https?:\/\//i.test(src)) {
      try { domains.add(new URL(src).origin); } catch { return undefined; }
      return src;
    }
    const path = resolve(src);
    const mime = IMAGE_MIME[extname(path).toLowerCase()];
    if (!mime || !opts.isPathAllowed(path)) return undefined;
    try {
      const size = statSync(path).size;
      if (size > INLINE_MAX_BYTES || size > budget) return undefined;
      budget -= size;
      return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
    } catch {
      return undefined;
    }
  };
  const language = opts.language ?? "it";
  const fragment = renderViewFragment(view.spec, { language, imageUrl, pageUrl: `${opts.origin}${viewPath(view.id)}` });
  const html = opts.fragment ? fragment : documentOf(view.spec.title, language, fragment);
  return { uri: viewResourceUri(view.id), mimeType: MCP_APP_MIME, html, resourceDomains: [...domains] };
}

const languageOf = (v: string | null): ViewLanguage => (v === "en" ? "en" : "it");

export function createViewsRouter(ctx: AppContext, opts: { dir?: string } = {}): RouteHandler {
  const { json, matchRoute, getTopicBySessionKey, isPathAllowed } = ctx;
  const dir = opts.dir ?? viewsDir(ctx.STATE_DIR);

  return async function viewsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
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
      // The drawn view goes back too, as markup without a document around it:
      // the MCP bridge hands it to the generic app of an MCP Apps host in the
      // tool result, without a second round trip.
      const app = viewApp(stored, { origin: url.origin, language: languageOf(url.searchParams.get("lang")), isPathAllowed, fragment: true });
      return json({ id, path: viewPath(id), spec: norm.spec, app }, 201);
    }

    if (method === "GET") {
      if (pathname === "/api/views") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
        let files: string[] = [];
        try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* no view yet */ }
        const views = files
          .map((f) => readStoredView(dir, f.slice(0, -5)))
          .filter((v): v is StoredView => !!v)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map((v) => ({ id: v.id, title: v.spec.title, view: v.spec.view, createdAt: v.createdAt }));
        return json({ views });
      }
      const app = matchRoute(pathname, "/api/views/:id/app");
      if (app) {
        const view = readStoredView(dir, app.id);
        if (!view) return json({ error: "view not found" }, 404);
        return json(viewApp(view, { origin: url.origin, language: languageOf(url.searchParams.get("lang")), isPathAllowed }));
      }
      const m = matchRoute(pathname, "/api/views/:id");
      if (!m) return null;
      const view = readStoredView(dir, m.id);
      if (!view) return json({ error: "view not found" }, 404);
      return json(view);
    }
    return null;
  };
}
