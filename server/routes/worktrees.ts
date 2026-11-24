/**
 * Routes — `/api/worktrees` (Phase A · migration 017)
 *
 * Surface:
 *   GET    /api/worktrees                        → list (optional ?project_id=, ?status=)
 *   GET    /api/worktrees/:id                    → single
 *   POST   /api/worktrees                        → create (returns 202 + pending row;
 *                                                  caller observes `worktree:updated`
 *                                                  via WS for ready/error transition)
 *   PATCH  /api/worktrees/:id                    → rename display `name` only
 *                                                  (git branch rename is deferred)
 *   DELETE /api/worktrees/:id                    → remove dir + (mode='branch') branch
 *   GET    /api/worktrees/gc/plan                → preview of the cleanup, per folder
 *   POST   /api/worktrees/relocate               → adopt | move | remove a worktree made
 *                                                  outside the root (`dryRun` = preview)
 *   POST   /api/worktrees/register               → a worktree another tool made (hook token)
 *   GET    /api/worktrees/placement?repo=|project= → where a creator puts one (hook token)
 *   POST   /api/worktrees/unregister             → forget one whose folder is gone (hook token)
 *
 * Every successful mutation broadcasts a `worktree:<verb>` envelope. The
 * create endpoint emits `worktree:new` synchronously with the row in
 * `pending` status; the manager later flips status and emits
 * `worktree:updated`.
 */
import type { AppContext, RouteHandler } from "../types";
import type { OutboundType } from "../../shared/ws-outbound";
import {
  WorktreeNameConflictError,
  WorktreePathConflictError,
} from "../services/worktree-store";
import {
  WorktreeRefusalError,
  WorktreeOperationError,
} from "../services/worktree-manager";
import { isValidWorktreeName } from "../utils/worktree-naming";
import { purgeWorktreeFromUiState } from "../services/ui-state-purge";
import { unwatchGitDir } from "../git-watcher";
import { unwatchProjectFiles } from "../file-watcher";
import { stripCtrl } from "../lib/strip-ctrl";
import { RELOCATE_ACTIONS, type RelocateAction, type WorktreePlanPayload } from "../../shared/worktree-plan";
import type { RelocateService } from "../boot/worktree-relocate-wiring";
import { isAbsoluteServerPath } from "../lib/absolute-path";
import { bearerMatches, isLoopbackHostRequest } from "../lib/hook-auth";
import { placementFor, placementForProject, registerWorktree, forgetWorktree, type RegisterDeps } from "../services/worktree-register";

/** The three routes of the registration door. */
const REGISTRATION_PATHS = new Set(["/api/worktrees/register", "/api/worktrees/placement", "/api/worktrees/unregister"]);

type RequestIdentity = ReturnType<NonNullable<AppContext["requestIdentity"]>>;

/**
 * WHO MAY USE THE REGISTRATION DOOR: a process on this machine holding the hook
 * token, and nobody else.
 *
 * The token is `claude-hooks/hook-token`, not the daemon token: the daemon token
 * opens every protected route of the server, the hook token opens only the hook
 * ingest and these three routes, and it is the file the hook script already
 * reads. A worktree lives on the machine of the server that registers it (B4),
 * so a caller from elsewhere has no business here: the Host must be this machine.
 * A delegated node credential or a guest is refused before the token is looked at.
 */
export function authorizeRegistration(
  req: Request,
  identity: RequestIdentity,
  token: string | null,
): { status: 401 | 403; error: string } | null {
  if (identity?.delegatedAuthorizationId) return { status: 403, error: "a delegated credential cannot register worktrees" };
  if (identity?.role === "guest") return { status: 403, error: "not available to a guest" };
  if (!isLoopbackHostRequest(req)) return { status: 403, error: "worktree registration is localhost-only" };
  if (!bearerMatches(req, token)) return { status: 401, error: "invalid hook token" };
  return null;
}

const ALLOWED_MODES = new Set(["branch", "reuse", "detached"]);
const ALLOWED_STATUSES = new Set(["pending", "ready", "error"]);
const BASE_REF_MAX = 200;
const BASE_REF_REGEX = /^[A-Za-z0-9_./-]+$/;

export interface WorktreesRouterOpts {
  /**
   * Lancia una passata del GC dei worktree e restituisce il riepilogo.
   *
   * Il GC gira già da solo ogni 30 minuti; questo è il "adesso" — serve a chi
   * guarda il contatore sulla board e vuole vedere l'effetto senza aspettare.
   * Il lavoro vero lo fa `sweepWorktrees`, che reapa SOLO ciò che è
   * provabilmente sicuro: il bottone non è più permissivo della passata
   * automatica, è la stessa passata anticipata.
   */
  runGc?: () => Promise<unknown>;
  /**
   * I rami locali non su main del progetto, con il task a cui appartengono.
   * Due letture (git e DB) che vivono nel boot del server, non qui.
   */
  branchInventory?: (projectPath: string) => Promise<unknown>;
  /** The cleanup preview, read only (`weigh` adds the on-disk size of each folder). `null` = it could not be built. */
  planGc?: (opts: { weigh: boolean }) => Promise<WorktreePlanPayload | null>;
  /** Adopt, move or remove a worktree made outside the root, by hand. */
  relocate?: RelocateService;
  /** The registration door: its effects and the token that opens it. Absent = 501. */
  registration?: { deps: () => RegisterDeps; token: () => string | null };
  /** Path rules for the routes that take a path; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

export function createWorktreesRouter(ctx: AppContext, opts: WorktreesRouterOpts = {}): RouteHandler {
  const {
    json,
    readJSON,
    matchRoute,
    errorResponse,
    worktreeStore,
    worktreeManager,
    broadcastToAll,
  } = ctx;

  function emit(type: OutboundType, worktree: unknown) {
    broadcastToAll({ type, worktree, payload_version: 1 });
  }

  return async function worktreesRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {

    // GET /api/worktrees (with optional filters)
    if (method === "GET" && pathname === "/api/worktrees") {
      const projectId = url.searchParams.get("project_id");
      // `project_path` e' il filtro che serve a chi conosce il PROGETTO ma non
      // il suo id di store: la board, per esempio, nasce da un path. Senza,
      // ogni chiamante dovrebbe scaricarsi l'elenco progetti solo per tradurre
      // un percorso in un uuid, e quella traduzione vive gia' qui.
      // Un path che non corrisponde a nessun progetto NON e' un errore: e' zero
      // worktree, che e' la risposta onesta (un progetto mai registrato non ne
      // ha). Filtrare su un id impossibile lo rende vero per costruzione.
      const projectPath = url.searchParams.get("project_path");
      const statusParam = url.searchParams.get("status");
      const opts: { projectId?: string; status?: "pending" | "ready" | "error" } = {};
      if (projectId !== null) opts.projectId = projectId;
      else if (projectPath !== null) {
        opts.projectId = ctx.projectStore.getByPath(projectPath)?.id ?? "\u0000nessun-progetto";
      }
      if (statusParam !== null) {
        if (!ALLOWED_STATUSES.has(statusParam)) {
          return errorResponse(400, `status must be one of: ${[...ALLOWED_STATUSES].join(", ")}`);
        }
        opts.status = statusParam as "pending" | "ready" | "error";
      }
      const worktrees = worktreeStore.list(opts).map((worktree) => ({
        ...worktree,
        port: worktreeManager.portForPath(worktree.absPath),
      }));
      return json({ worktrees });
    }

    // GET /api/worktrees/branches?project_path=… — i rami locali NON su main,
    // con il task a cui appartengono.
    //
    // Il chip «N non su main» della board conta solo i task CHIUSI: un ramo di
    // un task ancora in backlog — o di nessun task — non compariva da nessuna
    // parte. È così che quattro rami con lavoro fatto sono rimasti invisibili
    // per settimane mentre la board riproponeva come «da fare» cose già scritte
    // lì dentro.
    if (method === "GET" && pathname === "/api/worktrees/branches") {
      if (!opts.branchInventory) return errorResponse(501, "inventario dei rami non disponibile su questo host");
      const projectPath = url.searchParams.get("project_path");
      if (!projectPath) return errorResponse(400, "project_path richiesto");
      try {
        return json(await opts.branchInventory(projectPath));
      } catch (e) {
        return errorResponse(500, e instanceof Error ? e.message : String(e));
      }
    }

    // GET /api/worktrees/gc/plan — what the next cleanup would do, per folder. Writes nothing.
    if (method === "GET" && pathname === "/api/worktrees/gc/plan") {
      if (!opts.planGc) return errorResponse(501, "GC preview not available on this host");
      const plan = await opts.planGc({ weigh: url.searchParams.get("weigh") === "1" });
      return plan ? json({ plan }) : errorResponse(500, "the preview could not be built");
    }

    // POST /api/worktrees/relocate — { path, action, dryRun? }. Only folders git lists for a
    // known project are ever acted on; a refusal is a 200 with the reasons, not an error.
    if (method === "POST" && pathname === "/api/worktrees/relocate") {
      if (!opts.relocate) return errorResponse(501, "relocation not available on this host");
      const body = await readJSON(req);
      const path = stripCtrl(body?.path);
      const action = stripCtrl(body?.action) as RelocateAction;
      if (!path || !isAbsoluteServerPath(path, opts.platform)) return errorResponse(400, "path must be an absolute path");
      if (!(RELOCATE_ACTIONS as readonly string[]).includes(action)) {
        return errorResponse(400, `action must be one of: ${RELOCATE_ACTIONS.join(", ")}`);
      }
      if (body?.dryRun === true) return json({ check: await opts.relocate.check(action, path) });
      const result = await opts.relocate.run(action, path);
      if (result.ok) {
        // The watchers are keyed by path: the old one would watch a folder that is no longer there.
        if (action !== "adopt") { unwatchGitDir(path); unwatchProjectFiles(path); }
        const row = result.rowId ? worktreeStore.get(result.rowId) : null;
        if (action === "remove") { if (result.rowId) emit("worktree:deleted", { id: result.rowId }); }
        else if (row) emit(action === "adopt" ? "worktree:new" : "worktree:updated", row);
      }
      return json(result);
    }

    // The registration door: register, placement, unregister. Auth first, always.
    if (REGISTRATION_PATHS.has(pathname)) {
      if (!opts.registration) return errorResponse(501, "worktree registration not available on this host");
      const denied = authorizeRegistration(req, ctx.requestIdentity?.(req) ?? null, opts.registration.token());
      if (denied) return errorResponse(denied.status, denied.error);
      const deps = opts.registration.deps();
      if (method === "GET" && pathname === "/api/worktrees/placement") {
        const project = url.searchParams.get("project");
        const r = project !== null ? placementForProject(deps, project) : placementFor(deps, url.searchParams.get("repo"));
        return json(r.body, r.status);
      }
      if (method !== "POST") return errorResponse(405, "method not allowed");
      const body = await readJSON(req);
      if (!body || typeof body !== "object") return errorResponse(400, "body must be a JSON object");
      if (pathname === "/api/worktrees/unregister") {
        const r = forgetWorktree(deps, body.path);
        if (r.status === 200 && r.body.removed && r.body.id) emit("worktree:deleted", { id: r.body.id });
        return json(r.body, r.status);
      }
      if (pathname === "/api/worktrees/register") {
        const r = await registerWorktree(deps, body);
        if (r.status === 200 && r.body.created) {
          const row = worktreeStore.get(r.body.id);
          if (row) emit("worktree:new", row);
        }
        return json(r.body, r.status);
      }
      return errorResponse(405, "method not allowed");
    }

    // POST /api/worktrees/gc — una passata del GC, adesso.
    //
    // Va PRIMA della create, o `pathname === "/api/worktrees"` non lo
    // intercetterebbe comunque ma la rotta con suffisso deve precedere per
    // leggibilità: qui l'ordine non è ambiguo, ma tenerle vicine sì.
    if (method === "POST" && pathname === "/api/worktrees/gc") {
      if (!opts.runGc) return errorResponse(501, "GC non disponibile su questo host");
      const summary = await opts.runGc();
      // Il riepilogo porta anche i MOTIVI dei kept (worktree-gc.ts): chi preme
      // il bottone e vede "0 ripuliti" deve poter leggere perché, altrimenti il
      // bottone sembra rotto quando invece sta facendo la cosa giusta.
      return json({ ok: true, summary });
    }

    // POST /api/worktrees — create
    if (method === "POST" && pathname === "/api/worktrees") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");

      const projectId = stripCtrl(body.project_id ?? body.projectId);
      if (!projectId) return errorResponse(400, "project_id required");

      const mode = stripCtrl(body.mode);
      if (!mode || !ALLOWED_MODES.has(mode)) {
        return errorResponse(400, `mode must be one of: ${[...ALLOWED_MODES].join(", ")}`);
      }

      const baseRef = stripCtrl(body.base_ref ?? body.baseRef);
      if (!baseRef) return errorResponse(400, "base_ref required");
      if (baseRef.length > BASE_REF_MAX || !BASE_REF_REGEX.test(baseRef)) {
        return errorResponse(400, "base_ref contains invalid characters");
      }

      let name: string | undefined = undefined;
      if (body.name !== undefined && body.name !== null) {
        const candidate = stripCtrl(body.name);
        if (!candidate || !isValidWorktreeName(candidate)) {
          return errorResponse(
            400,
            "name must match /^[a-z][a-z0-9-]{0,63}$/",
          );
        }
        name = candidate;
      }

      try {
        const worktree = await worktreeManager.create({
          projectId,
          name,
          mode: mode as "branch" | "reuse" | "detached",
          baseRef,
        });
        emit("worktree:new", worktree);
        return json(worktree, 202); // accepted; status is `pending` until WS update
      } catch (err: any) {
        if (err instanceof WorktreeRefusalError) {
          return errorResponse(400, err.message);
        }
        if (err instanceof WorktreeNameConflictError) {
          return errorResponse(
            409,
            `Worktree name '${err.name}' already in use for this project`,
          );
        }
        if (err instanceof WorktreePathConflictError) {
          return errorResponse(409, `Worktree path already in use: ${err.absPath}`);
        }
        if (err instanceof WorktreeOperationError) {
          return errorResponse(500, `git failed: ${err.message}`, {
            details: err.stderr.slice(0, 1000),
          });
        }
        throw err;
      }
    }

    // /api/worktrees/:id sub-tree
    {
      const idParams = matchRoute(pathname, "/api/worktrees/:id");
      if (idParams) {
        if (method === "GET") {
          const wt = worktreeStore.get(idParams.id);
          if (!wt) return errorResponse(404, "Worktree not found");
          return json({ ...wt, port: worktreeManager.portForPath(wt.absPath) });
        }
        if (method === "PATCH") {
          const body = await readJSON(req);
          if (!body) return errorResponse(400, "body required");

          const patch: Parameters<typeof worktreeStore.update>[1] = {};

          if (body.name !== undefined) {
            const candidate = stripCtrl(body.name);
            if (!candidate || !isValidWorktreeName(candidate)) {
              return errorResponse(400, "name must match /^[a-z][a-z0-9-]{0,63}$/");
            }
            patch.name = candidate;
          }
          // PATCH in this phase is intentionally narrow — only the display
          // name is mutable. Branch rename, mode change, path move are
          // explicitly out of scope per design D4 / WORKTREE-04.
          if (Object.keys(patch).length === 0) {
            return errorResponse(400, "no mutable field provided (only `name` is editable in this phase)");
          }

          try {
            const wt = worktreeStore.update(idParams.id, patch);
            if (!wt) return errorResponse(404, "Worktree not found");
            emit("worktree:updated", wt);
            return json(wt);
          } catch (err: any) {
            if (err instanceof WorktreeNameConflictError) {
              return errorResponse(
                409,
                `Worktree name '${err.name}' already in use for this project`,
              );
            }
            throw err;
          }
        }
        if (method === "DELETE") {
          const wt = worktreeStore.get(idParams.id);
          if (!wt) return errorResponse(404, "Worktree not found");
          // The manager runs the disk + branch cleanup, then deletes the
          // row. The FK ON DELETE SET NULL on `topics.worktree_id` (mig
          // 018) takes care of bound topics. We additionally purge any
          // worktree references inside `ui_state` snapshots so cross-
          // device LWW cannot resurrect the deleted id (WORKTREE-03).
          let ok: boolean;
          try {
            ok = await worktreeManager.delete(idParams.id);
          } catch (err) {
            // The folder survived both git and our own rm: the manager keeps
            // the row so the GC retries. A 404 here would claim the opposite.
            if (err instanceof WorktreeOperationError) {
              return errorResponse(409, err.message, { details: err.stderr.slice(0, 1000) });
            }
            throw err;
          }
          if (!ok) return errorResponse(404, "Worktree not found");
          // Drop any live git watcher on the deleted path. Worktree paths are
          // deterministic (~/.topics/worktrees/<slug>/<name>), so a stale
          // watcher entry would make a SAME-NAME re-create hit watchGitDir's
          // idempotency early-return — the new worktree would never get live
          // git:status broadcasts (and 3 fs.watch handles would leak on a
          // directory that no longer exists).
          unwatchGitDir(wt.absPath);
          unwatchProjectFiles(wt.absPath);
          const purge = purgeWorktreeFromUiState(ctx.db, broadcastToAll, idParams.id);
          if (!purge.ok) {
            return errorResponse(500, "Failed to purge ui_state references", {
              details: purge.error,
            });
          }
          emit("worktree:deleted", { id: idParams.id });
          return json({ ok: true });
        }
      }
    }

    return null;
  };
}
