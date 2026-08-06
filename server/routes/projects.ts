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
import type { OutboundType } from "../../shared/ws-outbound";
import { SlugConflictError, ProjectInUseError } from "../services/project-store";
import { unwatchGitDir } from "../git-watcher";
import { unwatchProjectFiles } from "../file-watcher";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { resolveProjectIcon, ICON_CONTENT_TYPE } from "../lib/project-icon";

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
// Lives in ../lib/project-icon.ts (pure fs helpers, unit-tested); this route
// only gates access (allowlist + realpath containment) and serves the bytes.

export function createProjectsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, projectStore, broadcastToAll } = ctx;

  function emit(type: OutboundType, project: unknown) {
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
    // web-manifest icon (image only, contained within the dir), o 204 se non ne
    // ha nessuna (vedi più sotto: «non c'è icona» non è un errore). Lets
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
      // for an exact match (symlink-safe). Cheap enough per request: sia la
      // risposta con icona sia il 204 «non ne ha» portano un `max-age`, quindi
      // la cache HTTP del browser tiene questo endpoint fuori dai cicli caldi.
      // (Il client NON persiste i 'none' su disco — è un'invariante di
      // ProjectFavicon.tsx: sono già bastati quattro bump di chiave.)
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
      // Projects opened as WINDOWS (folder picker / sidebar) but never registered
      // in projectStore, never linked to a topic, and with no terminal session in
      // their dir are referenced ONLY in the client's persisted UI snapshots
      // (sidebar `expandedNodes` + each window's project panes). Without this
      // source the icon endpoint 403'd every such window, so its favicon never
      // loaded — the "project icons no longer show" regression. Both encodings
      // appear: pane ids encode the path (`project:%2FUsers%2F…`), sidebar
      // expandedNodes store it raw (`project:/Users/…`); the token is realpath'd
      // by addPath, so a non-existent match is dropped. Same boundary as the
      // terminal-cwd source above — an attacker can't inject a ui_state row via
      // this GET, so the union stays a real allowlist, not arbitrary client input.
      try {
        const projTokenRe = /project:((?:%2[Ff]|\/)[^"\\]*)/g;
        for (const row of ctx.db.query("SELECT value FROM ui_state").all() as Array<{ value?: string }>) {
          const v = row.value;
          if (typeof v !== "string" || !v.includes("project:")) continue;
          let m: RegExpExecArray | null;
          while ((m = projTokenRe.exec(v)) !== null) {
            let p = m[1];
            try { p = decodeURIComponent(p); } catch { /* keep raw token */ }
            addPath(p);
          }
        }
      } catch {}
      if (!allowedRealDirs.has(realDir)) {
        console.log(`[icon] 403 (not in allowlist): ${realDir}`);
        return new Response(null, { status: 403 });
      }
      const resolved = resolveProjectIcon(realDir);
      console.log(`[icon] ${resolved ? (resolved.kind === "file" ? "200 " + resolved.path : `200 inline(${resolved.contentType})`) : "204 no-icon"} ← ${realDir} [ua=${(req.headers.get("user-agent") || "?").slice(0, 60)} ref=${(req.headers.get("referer") || "?").slice(0, 60)} dest=${req.headers.get("sec-fetch-dest") || "?"}]`);
      // 204, non 404: la directory esiste, è nell'allowlist, e la risposta è
      // «non c'è nessuna icona» — che è un esito RIUSCITO della domanda, non una
      // risorsa mancante. Il 404 era la fonte più rumorosa dei 4xx a ogni load
      // (un progetto senza icona = un errore rosso in console per ogni superficie
      // che lo mostra), e non poteva essere zittito dal lato client: il cache
      // dei 'none' su localStorage è VIETATO in ProjectFavicon.tsx — quattro bump
      // di chiave (v1→v4) sono serviti a ripulire 'none' incastrati da guasti
      // transitori, e da allora l'invariante è che su disco finisce solo 'has'.
      // Resta 404 per una directory che non esiste e 403 per una fuori allowlist:
      // là il codice di errore è l'informazione. Il `max-age` evita di rileggere
      // il disco a ogni riapertura della palette.
      if (!resolved) return new Response(null, { status: 204, headers: { "cache-control": "max-age=120" } });
      // Project icons are arbitrary content from the project dir served on
      // OUR origin. An SVG favicon (file OR inline data: URI) can carry
      // <script>/<foreignObject> that executes if the icon URL is opened as a
      // top-level document — a same-origin stored-XSS vector (this origin
      // drives terminals/agents). Lock every icon response down so it can
      // never run as script: sandboxed CSP (no allow-scripts) neutralises SVG
      // scripts, nosniff blocks MIME confusion, inline disposition prevents
      // the browser from treating it as a navigable document with privileges.
      // <img>-loaded favicons (the only real use) are unaffected.
      const iconHeaders = (ct: string) => ({
        "content-type": ct,
        "cache-control": "max-age=300",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "content-disposition": 'inline; filename="icon"',
      });
      // Inline icons (index.html data: URI favicons) carry their own bytes —
      // size-capped and content-type-allowlisted by the resolver.
      if (resolved.kind === "inline") {
        return new Response(Buffer.from(resolved.bytes), { headers: iconHeaders(resolved.contentType) });
      }
      // Containment: a resolved icon FILE must live inside the project dir.
      let realIcon: string;
      try { realIcon = realpathSync(resolved.path); } catch { return new Response(null, { status: 404 }); }
      if (realIcon !== realDir && !realIcon.startsWith(realDir + "/")) return new Response(null, { status: 403 });
      const ct = ICON_CONTENT_TYPE[extname(realIcon).toLowerCase()];
      if (!ct) return new Response(null, { status: 404 });
      try {
        return new Response(readFileSync(realIcon), { headers: iconHeaders(ct) });
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
            // Capture the path before deletion so we can release the project's
            // git watcher (3 fs.watch handles opened lazily by GET /api/git/status).
            // Without this they leak for the life of the server process — mirrors
            // the unwatchGitDir call on worktree deletion.
            const doomed = projectStore.get(idParams.id);
            const ok = projectStore.delete(idParams.id);
            if (!ok) return errorResponse(404, "Project not found");
            if (doomed) { unwatchGitDir(doomed.path); unwatchProjectFiles(doomed.path); }
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
