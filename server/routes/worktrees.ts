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
 *
 * Every successful mutation broadcasts a `worktree:<verb>` envelope. The
 * create endpoint emits `worktree:new` synchronously with the row in
 * `pending` status; the manager later flips status and emits
 * `worktree:updated`.
 */
import type { AppContext, RouteHandler } from "../types";
import type { OutboundType } from "../schemas/ws-outbound";
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

const ALLOWED_MODES = new Set(["branch", "reuse", "detached"]);
const ALLOWED_STATUSES = new Set(["pending", "ready", "error"]);
const BASE_REF_MAX = 200;
const BASE_REF_REGEX = /^[A-Za-z0-9_./\-]+$/;

function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

export function createWorktreesRouter(ctx: AppContext): RouteHandler {
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
      const statusParam = url.searchParams.get("status");
      const opts: { projectId?: string; status?: "pending" | "ready" | "error" } = {};
      if (projectId !== null) opts.projectId = projectId;
      if (statusParam !== null) {
        if (!ALLOWED_STATUSES.has(statusParam)) {
          return errorResponse(400, `status must be one of: ${[...ALLOWED_STATUSES].join(", ")}`);
        }
        opts.status = statusParam as "pending" | "ready" | "error";
      }
      const worktrees = worktreeStore.list(opts);
      return json({ worktrees });
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
          return json(wt);
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
          const ok = await worktreeManager.delete(idParams.id);
          if (!ok) return errorResponse(404, "Worktree not found");
          // Drop any live git watcher on the deleted path. Worktree paths are
          // deterministic (~/.topics/worktrees/<slug>/<name>), so a stale
          // watcher entry would make a SAME-NAME re-create hit watchGitDir's
          // idempotency early-return — the new worktree would never get live
          // git:status broadcasts (and 3 fs.watch handles would leak on a
          // directory that no longer exists).
          unwatchGitDir(wt.absPath);
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
