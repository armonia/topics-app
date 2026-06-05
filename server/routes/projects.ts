/**
 * Routes — `/api/projects` (Phase A · migration 016)
 *
 * Surface:
 *   GET    /api/projects[?archived=true|false]  → list
 *   GET    /api/projects?path=<abs>             → lookup-or-null (200 with body=null on miss)
 *   GET    /api/projects/:id                    → single
 *   POST   /api/projects                        → create (auto-generates slug from name when omitted)
 *   PATCH  /api/projects/:id                    → update (name, color, icon)
 *   POST   /api/projects/:id/archive            → set archived=1
 *   POST   /api/projects/:id/restore            → set archived=0
 *   DELETE /api/projects/:id                    → row delete (refuses if any worktree exists)
 *
 * Every successful mutation broadcasts a `project:<verb>` envelope via
 * `broadcastToAll`, mirrored by the response. Validation is structural
 * (length caps, control-char strip, regex on slug) and surfaces 400/404/
 * 409 with clear messages.
 */
import type { AppContext, RouteHandler } from "../types";
import { SlugConflictError, ProjectInUseError } from "../services/project-store";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, extname } from "node:path";

const NAME_MAX = 200;
const SLUG_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
// Reasonable cap for an emoji or short string; lets multi-codepoint emoji through.
const ICON_MAX = 16;

function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

// ── Project icon (favicon / web-manifest) resolution ─────────────────────
const ICON_CONTENT_TYPE: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Conventional favicon/logo locations, in priority order. Covers Vite/CRA
// (public/), SvelteKit/Hugo (static/), Next.js app-dir (app/icon.*), and bare
// roots. Returns the first existing FILE, or null.
const ICON_CANDIDATES = [
  "favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png", "logo.svg", "logo.png",
  "public/favicon.svg", "public/favicon.png", "public/favicon.ico", "public/icon.svg",
  "public/icon.png", "public/apple-touch-icon.png", "public/logo.svg", "public/logo.png",
  "static/favicon.svg", "static/favicon.png", "static/favicon.ico", "static/logo.png",
  "src/favicon.svg", "src/favicon.png", "src/favicon.ico", "src/assets/favicon.png", "src/assets/logo.png",
  "app/icon.svg", "app/icon.png", "app/favicon.ico", "app/apple-icon.png",
  "assets/favicon.png", "assets/logo.png",
];
const MANIFEST_CANDIDATES = [
  "public/manifest.json", "public/site.webmanifest", "public/manifest.webmanifest",
  "manifest.json", "site.webmanifest", "manifest.webmanifest",
];

function isFile(p: string): boolean {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}

/** Resolve a project's icon file (absolute path) from common favicon/manifest
 *  locations, or null if none. `dir` must already be a realpath'd directory. */
function resolveProjectIcon(dir: string): string | null {
  for (const rel of ICON_CANDIDATES) {
    const p = join(dir, rel);
    if (isFile(p) && extname(p).toLowerCase() in ICON_CONTENT_TYPE) return p;
  }
  // Web manifest: pick the icon with the largest declared size (fallback first).
  for (const rel of MANIFEST_CANDIDATES) {
    const mp = join(dir, rel);
    if (!isFile(mp)) continue;
    try {
      const m = JSON.parse(readFileSync(mp, "utf-8"));
      const icons: Array<{ src?: string; sizes?: string }> = Array.isArray(m.icons) ? m.icons : [];
      const scored = icons
        .filter((i) => typeof i.src === "string" && !/^(https?:)?\/\//.test(i.src!) && !i.src!.startsWith("data:"))
        .map((i) => ({ src: i.src!, size: parseInt((i.sizes || "0").split("x")[0], 10) || 0 }))
        .sort((a, b) => b.size - a.size);
      for (const { src } of scored) {
        const cand = join(dirname(mp), src.replace(/^\//, ""));
        if (isFile(cand) && extname(cand).toLowerCase() in ICON_CONTENT_TYPE) return cand;
      }
    } catch { /* malformed manifest — ignore */ }
  }
  // index.html <link rel="icon">
  for (const rel of ["index.html", "public/index.html"]) {
    const hp = join(dir, rel);
    if (!isFile(hp)) continue;
    try {
      const html = readFileSync(hp, "utf-8");
      const m = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)
        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
      const href = m?.[1];
      if (href && !/^(https?:)?\/\//.test(href) && !href.startsWith("data:")) {
        const cand = join(dirname(hp), href.replace(/^\//, ""));
        if (isFile(cand) && extname(cand).toLowerCase() in ICON_CONTENT_TYPE) return cand;
      }
    } catch { /* unreadable — ignore */ }
  }
  return null;
}

export function createProjectsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, projectStore, broadcastToAll } = ctx;

  function emit(type: string, project: unknown) {
    broadcastToAll({ type, project, payload_version: 1 });
  }

  return async function projectsRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {

    // GET /api/projects (list, optional ?archived=, optional ?path= for lookup)
    if (method === "GET" && pathname === "/api/projects") {
      const path = url.searchParams.get("path");
      if (path !== null) {
        const project = projectStore.getByPath(path);
        return json(project); // null on miss is intentional (200 with body=null)
      }
      const archivedParam = url.searchParams.get("archived");
      let opts: { archived?: boolean } = {};
      if (archivedParam === "true") opts.archived = true;
      else if (archivedParam === "false") opts.archived = false;
      const projects = projectStore.list(opts);
      return json({ projects });
    }

    // GET /api/projects/icon?path=<abs dir> → serve the project's favicon /
    // web-manifest icon (image only, contained within the dir), or 404. Lets
    // the sidebar + command palette show a real project glyph when one exists
    // instead of a generic folder. MUST stay above the `/api/projects/:id`
    // matcher below so "icon" isn't captured as an :id.
    if (method === "GET" && pathname === "/api/projects/icon") {
      const dir = url.searchParams.get("path");
      if (!dir || !dir.startsWith("/")) return errorResponse(400, "path required (absolute)");
      let realDir: string;
      try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return new Response(null, { status: 404 });
        realDir = realpathSync(dir);
      } catch { return new Response(null, { status: 404 }); }
      // Allowlist gate (SECURITY): only serve icons for directories the server
      // ALREADY references. Without it, the client-supplied `path` lets a caller
      // probe arbitrary directories for existence and read image / manifest /
      // index.html files from anywhere on disk — arbitrary file access &
      // filesystem enumeration on our origin (which drives terminals + agents).
      //
      // `projectStore` alone is too narrow: in this app most projects are opened
      // ad-hoc (folder picker, Claude Code terminals) and never registered there,
      // so the gate is the UNION of every server-known project dir — registered
      // projects, topic project paths, worktree paths, and terminal-session cwds.
      // An attacker can't add an entry to any of these by calling this endpoint,
      // so the union is a real boundary, not arbitrary client input. Realpath'd
      // for an exact match (symlink-safe). Cheap enough per request (the client
      // caches both icon and 404 responses, so it isn't hit in a hot loop).
      const allowedRealDirs = new Set<string>();
      const addPath = (pth: unknown) => {
        if (typeof pth !== "string" || !pth) return;
        try { allowedRealDirs.add(realpathSync(pth)); } catch { /* gone/unreadable */ }
      };
      try { for (const p of projectStore.list({ archived: null as any })) addPath(p.path); } catch {}
      try { for (const t of Object.values(ctx.loadTopics().topics)) addPath((t as { projectPath?: string }).projectPath); } catch {}
      try { for (const w of ctx.worktreeStore.list()) addPath((w as { absPath?: string }).absPath); } catch {}
      try {
        for (const row of ctx.db.query("SELECT DISTINCT cwd FROM terminal_sessions").all() as Array<{ cwd?: string }>) {
          addPath(row.cwd);
        }
      } catch {}
      if (!allowedRealDirs.has(realDir)) return new Response(null, { status: 403 });
      const iconFile = resolveProjectIcon(realDir);
      // Cache the "no icon" answer too so palette re-opens don't re-probe disk.
      if (!iconFile) return new Response(null, { status: 404, headers: { "cache-control": "max-age=120" } });
      // Containment: the resolved icon must live inside the project dir.
      let realIcon: string;
      try { realIcon = realpathSync(iconFile); } catch { return new Response(null, { status: 404 }); }
      if (realIcon !== realDir && !realIcon.startsWith(realDir + "/")) return new Response(null, { status: 403 });
      const ct = ICON_CONTENT_TYPE[extname(realIcon).toLowerCase()];
      if (!ct) return new Response(null, { status: 404 });
      try {
        return new Response(readFileSync(realIcon), {
          headers: {
            "content-type": ct,
            "cache-control": "max-age=300",
            // Project icons are arbitrary files from the project dir served on
            // OUR origin. An SVG favicon can carry inline <script>/<foreignObject>
            // that executes if the icon URL is opened as a top-level document —
            // a same-origin stored-XSS vector (this origin drives terminals/
            // agents). Lock every icon response down so it can never run as
            // script: sandboxed CSP (no allow-scripts) neutralises SVG scripts,
            // nosniff blocks MIME confusion, inline disposition prevents the
            // browser from treating it as a navigable document with privileges.
            // <img>-loaded favicons (the only real use) are unaffected.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "x-content-type-options": "nosniff",
            "content-disposition": 'inline; filename="icon"',
          },
        });
      } catch { return new Response(null, { status: 404 }); }
    }

    // POST /api/projects
    if (method === "POST" && pathname === "/api/projects") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");

      const name = stripCtrl(body.name);
      if (!name) return errorResponse(400, "name required");
      if (name.length > NAME_MAX) return errorResponse(400, `name too long (max ${NAME_MAX})`);

      const path = stripCtrl(body.path);
      if (!path) return errorResponse(400, "path required");
      if (!path.startsWith("/")) return errorResponse(400, "path must be absolute");
      if (!existsSync(path)) return errorResponse(400, `path does not exist: ${path}`);
      if (!statSync(path).isDirectory()) return errorResponse(400, `path is not a directory: ${path}`);

      let slug = stripCtrl(body.slug);
      if (!slug) slug = projectStore.slugify(name);
      if (!SLUG_REGEX.test(slug)) {
        return errorResponse(400, `invalid slug (must match ${SLUG_REGEX})`);
      }

      const color = body.color != null ? stripCtrl(body.color) : null;
      if (color !== null && !COLOR_REGEX.test(color)) {
        return errorResponse(400, "color must be #RRGGBB");
      }
      const icon = body.icon != null ? stripCtrl(body.icon) : null;
      if (icon !== null && icon.length > ICON_MAX) {
        return errorResponse(400, `icon too long (max ${ICON_MAX})`);
      }

      try {
        const project = projectStore.create({ name, slug, path, color, icon });
        emit("project:new", project);
        return json(project, 201);
      } catch (err: any) {
        if (err instanceof SlugConflictError) {
          return errorResponse(409, `slug already in use: ${err.slug}`);
        }
        throw err;
      }
    }

    // /api/projects/:id sub-tree
    {
      const idParams = matchRoute(pathname, "/api/projects/:id");
      if (idParams) {
        if (method === "GET") {
          const project = projectStore.get(idParams.id);
          if (!project) return errorResponse(404, "Project not found");
          return json(project);
        }
        if (method === "PATCH") {
          const body = await readJSON(req);
          if (!body) return errorResponse(400, "body required");
          const patch: { name?: string; color?: string | null; icon?: string | null } = {};
          if (body.name !== undefined) {
            const v = stripCtrl(body.name);
            if (!v) return errorResponse(400, "name cannot be empty");
            if (v.length > NAME_MAX) return errorResponse(400, `name too long (max ${NAME_MAX})`);
            patch.name = v;
          }
          if (body.color !== undefined) {
            if (body.color === null) patch.color = null;
            else {
              const v = stripCtrl(body.color);
              if (v === null || !COLOR_REGEX.test(v)) {
                return errorResponse(400, "color must be #RRGGBB or null");
              }
              patch.color = v;
            }
          }
          if (body.icon !== undefined) {
            if (body.icon === null) patch.icon = null;
            else {
              const v = stripCtrl(body.icon);
              if (v === null || v.length === 0) {
                return errorResponse(400, "icon cannot be empty (use null to clear)");
              }
              if (v.length > ICON_MAX) {
                return errorResponse(400, `icon too long (max ${ICON_MAX})`);
              }
              patch.icon = v;
            }
          }
          const project = projectStore.update(idParams.id, patch);
          if (!project) return errorResponse(404, "Project not found");
          emit("project:updated", project);
          return json(project);
        }
        if (method === "DELETE") {
          try {
            const ok = projectStore.delete(idParams.id);
            if (!ok) return errorResponse(404, "Project not found");
            emit("project:deleted", { id: idParams.id });
            return json({ ok: true });
          } catch (err: any) {
            if (err instanceof ProjectInUseError) {
              return errorResponse(
                409,
                `Project has ${err.worktreeCount} worktree(s) — delete them first`,
              );
            }
            throw err;
          }
        }
      }
    }

    // POST /api/projects/:id/archive
    {
      const params = matchRoute(pathname, "/api/projects/:id/archive");
      if (params && method === "POST") {
        const project = projectStore.archive(params.id);
        if (!project) return errorResponse(404, "Project not found");
        emit("project:archived", project);
        return json(project);
      }
    }

    // POST /api/projects/:id/restore
    {
      const params = matchRoute(pathname, "/api/projects/:id/restore");
      if (params && method === "POST") {
        const project = projectStore.restore(params.id);
        if (!project) return errorResponse(404, "Project not found");
        emit("project:updated", project);
        return json(project);
      }
    }

    return null;
  };
}
