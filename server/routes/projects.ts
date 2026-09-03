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
 * Every successful mutation broadcasts a `project:<verb>` envelope, mirrored by
 * the response. I tre che portano la RIGA INTERA (`new`/`updated`/`archived`)
 * escono da `ctx.broadcastProject`, che decide socket per socket con la stessa
 * regola dell'elenco: senza, il filtro della 092 valeva su `GET /api/projects` e
 * il broadcast subito dopo rimetteva nome e path in chiaro a chiunque fosse
 * connesso. `project:deleted` resta su `broadcastToAll` perché porta il solo id.
 *
 * Validation is structural (length caps, control-char strip, regex on slug) and
 * surfaces 400/404/409 with clear messages.
 */
import type { AppContext, RouteHandler } from "../types";
import { SlugConflictError, ProjectInUseError } from "../services/project-store";
import { unwatchGitDir } from "../git-watcher";
import { unwatchProjectFiles } from "../file-watcher";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveProjectIcon, ICON_CONTENT_TYPE } from "../lib/project-icon";
import { knownProjectDirs } from "../services/known-project-dirs";
import { osservatoreDaDispositivo, vedeProgetto, visibilitaDi } from "../lib/project-visibility";
import { resolveOsOpenPath, fsProbe } from "../lib/os-open-path";
import { installationOrgId, actingPersonId } from "../lib/orgs";

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
// L'allowlist è ../services/known-project-dirs.ts — condivisa con le rotte dei
// file, non una copia: due copie sono due confini che divergono.

/** The icon route keeps the known-project allowlist for this long; a miss rebuilds it before denying. */
const ICON_ALLOW_TTL_MS = 5_000;
let iconAllowCache: { at: number; dirs: Set<string>; db: unknown } | null = null;

export function createProjectsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, projectStore, broadcastToAll, broadcastProject } = ctx;

  /**
   * La riga intera esce SOLO verso chi la vede: `broadcastProject` chiede
   * `vedeProgetto` socket per socket, e a chi non vede manda la ritratta. Il
   * giro da `broadcastToAll` — un payload solo, uguale per tutte le socket — è
   * quello che consegnava nome e path di un incognito a ogni finestra connessa.
   *
   * Non è un alias per comodità: il tipo di `broadcastProject` NON ammette
   * `project:deleted`, quindi il giorno in cui qualcuno aggiunge un quinto verbo
   * la scelta fra i due canali gliela chiede il compilatore.
   */
  const emit = broadcastProject;

  /**
   * Chi sta chiedendo, tradotto nella forma che la regola di visibilità legge
   * (`server/lib/project-visibility.ts`). Senza `requestIdentity` — i test che
   * non lo stubbano, e ogni percorso che non passa dal gate — si ricade sul
   * loopback, cioè sulla macchina: è il caso in cui QUESTO filtro non deve
   * cambiare niente rispetto a prima.
   */
  function osservatore(req: Request) {
    const id = ctx.requestIdentity?.(req) ?? null;
    return osservatoreDaDispositivo(ctx.db as never, id?.deviceId ?? null);
  }

  const visibile = (req: Request, p: { orgId?: string | null; ownerPersonId?: string | null; incognito?: boolean }) =>
    vedeProgetto(osservatore(req), visibilitaDi(p));

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
        // Un progetto che non ti riguarda risponde come se non esistesse: la
        // stessa forma del miss. Un 403 direbbe «c'è ma non te lo do», che su
        // una lookup per path è già la risposta che qualcuno cercava.
        if (project && !visibile(req, project)) return json(null);
        return json(project); // null on miss is intentional (200 with body=null)
      }
      const archivedParam = url.searchParams.get("archived");
      let opts: { archived?: boolean } = {};
      if (archivedParam === "true") opts.archived = true;
      else if (archivedParam === "false") opts.archived = false;
      // Il filtro sta QUI e non nel SQL dello store: la regola è una funzione
      // pura provata a parte, e un secondo `WHERE` che prova a dire la stessa
      // cosa in SQL è la copia che diverge.
      const chi = osservatore(req);
      const projects = projectStore.list(opts).filter((p) => vedeProgetto(chi, visibilitaDi(p)));
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
      // Il confine è l'UNIONE delle dir note al server
      // (`services/known-project-dirs.ts`), la STESSA che usano le rotte dei
      // file: `projectStore` da solo è troppo stretto (qui i progetti si aprono
      // al volo e non ci finiscono mai). Fino al 2026-08-07 questa rotta ne
      // teneva una COPIA in linea, ed è divergente com'era prevedibile: la
      // sesta sorgente — i progetti che il server enumera nel workspace, quelli
      // che l'indice della board MOSTRA — esisteva solo di là, quindi
      // `workspace/dashboard` e `workspace/dancerooms` si vedevano nella lista
      // e prendevano 403 sulla favicon.
      //
      // Ricalcolata a ogni richiesta, MAI messa in cache: una cache che decide
      // un DINIEGO cristallizza il diniego, e una cartella appena aperta è già
      // legittima ([[project_project-allowlist-cache-denies]]). Costa due query
      // e un `realpath` per voce, e non sta su un percorso caldo: sia l'icona
      // sia il 204 «non ne ha» portano un `max-age`, quindi la cache HTTP del
      // browser tiene fuori questo endpoint dai cicli caldi. (Il client NON
      // persiste i 'none' su disco — è un'invariante di ProjectFavicon.tsx:
      // sono già bastati quattro bump di chiave.)
      //
      // Corrispondenza ESATTA, non «dentro»: qui si chiede l'icona DI un
      // progetto, non di una sua sottocartella — `isInsideKnownProject`
      // aprirebbe ogni discendente all'enumerazione.
      // Measured 2026-09-03: 1.7-4.1s per icon with fifteen pinned tiles asking
      // at once, because every request rebuilt the whole allowlist. The set
      // is kept for a few seconds, and a MISS rebuilds it before denying:
      // a folder opened a moment ago is allowed on the rebuild, so the cache
      // can only ever confirm, never crystallise a denial.
      const iconAllowlist = (fresh: boolean): Set<string> => {
        const now = Date.now();
        if (!fresh && iconAllowCache && iconAllowCache.db === ctx.db && now - iconAllowCache.at < ICON_ALLOW_TTL_MS) return iconAllowCache.dirs;
        const dirs = knownProjectDirs({
          db: ctx.db,
          loadTopics: ctx.loadTopics,
          worktreeStore: ctx.worktreeStore,
          projectStore,
          workspaceDir: join(ctx.OPENCLAW_DIR, "workspace"),
        });
        iconAllowCache = { at: now, dirs, db: ctx.db };
        return dirs;
      };
      let allowed = iconAllowlist(false).has(realDir);
      if (!allowed) allowed = iconAllowlist(true).has(realDir);
      if (!allowed) {
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

    // GET /api/projects/resolve-open?path=<abs> → la tab da aprire per un path
    // consegnato dal sistema operativo («Apri con Topics»), o null.
    //
    // Sta qui perché la domanda è «di che progetto fa parte questo path»: la
    // regola è pura (`shared/os-open-path.ts`), la sonda del disco è in
    // `server/lib/os-open-path.ts`, e questa riga è solo la porta.
    //
    // Niente allowlist, e non è una svista: il senso della funzione è aprire
    // una cartella che l'app NON conosce ancora, quindi un elenco di path
    // ammessi la spegnerebbe. Quello che esce di qui è solo il verdetto sul
    // path che il chiamante ha già scritto (esiste? è cartella? qual è la
    // radice), mai un contenuto: il confine sui contenuti resta dov'era.
    // MUST stay above the `/api/projects/:id` matcher.
    if (method === "GET" && pathname === "/api/projects/resolve-open") {
      const raw = url.searchParams.get("path");
      if (!raw) return errorResponse(400, "path required");
      const chi = osservatore(req);
      const target = resolveOsOpenPath(
        raw,
        fsProbe(() =>
          projectStore
            .list({ archived: false })
            .filter((p) => vedeProgetto(chi, visibilitaDi(p)))
            .map((p) => p.path)
            .filter((p): p is string => typeof p === "string" && p.length > 0),
        ),
      );
      return json({ target });
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
        // Il progetto nasce nell'organizzazione dell'installazione e intestato a
        // chi lo sta creando (migration 092). Non è una scelta dell'utente: se
        // lo fosse, il primo progetto creato prima che qualcuno ci pensasse
        // resterebbe fuori dall'org per sempre. Chi non vuole condividerlo lo
        // marca incognito DOPO, che è una leva reversibile.
        const project = projectStore.create({
          name, slug, path, color, icon,
          orgId: installationOrgId(ctx.db as never),
          ownerPersonId: actingPersonId(ctx.db as never, ctx.requestIdentity?.(req)?.deviceId ?? null),
        });
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
        // Un progetto che non vedi non esiste, per QUALUNQUE verbo. Il controllo
        // sta prima del dispatch e non dentro i singoli rami perché un ramo
        // dimenticato qui non è una lettura di troppo: è una PATCH o una DELETE
        // su una risorsa di qualcun altro.
        {
          const esistente = projectStore.get(idParams.id);
          if (esistente && !visibile(req, esistente)) return errorResponse(404, "Project not found");
        }
        if (method === "GET") {
          const project = projectStore.get(idParams.id);
          if (!project) return errorResponse(404, "Project not found");
          return json(project);
        }
        if (method === "PATCH") {
          const body = await readJSON(req);
          if (!body) return errorResponse(400, "body required");
          const patch: { name?: string; color?: string | null; icon?: string | null; incognito?: boolean } = {};
          // L'interruttore incognito. Booleano stretto: un `"true"` di stringa o
          // un `1` NON valgono, perché un cast permissivo su una leva di
          // visibilità trasforma ogni errore di battitura del client in una
          // condivisione.
          if (body.incognito !== undefined) {
            if (typeof body.incognito !== "boolean") return errorResponse(400, "incognito must be a boolean");
            patch.incognito = body.incognito;
          }
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
            // L'unico che resta su `broadcastToAll`: porta il solo id, cioè è già
            // la forma ridotta che le altre tre assumono per chi non vede. E la
            // riga non c'è più: non ci sarebbe niente da valutare.
            broadcastToAll({ type: "project:deleted", project: { id: idParams.id }, payload_version: 1 });
            return json({ ok: true });
          } catch (err: any) {
            if (err instanceof ProjectInUseError) {
              return errorResponse(
                409,
                `Project has ${err.worktreeCount} worktree(s). Delete them first.`,
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
        const prima = projectStore.get(params.id);
        if (prima && !visibile(req, prima)) return errorResponse(404, "Project not found");
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
        const prima = projectStore.get(params.id);
        if (prima && !visibile(req, prima)) return errorResponse(404, "Project not found");
        const project = projectStore.restore(params.id);
        if (!project) return errorResponse(404, "Project not found");
        emit("project:updated", project);
        return json(project);
      }
    }

    return null;
  };
}
