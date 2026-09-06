/**
 * Routes: `/api/nodes/runs`, the INGRESS of a card mirrored from another
 * machine (KANBAN-76). This code runs ON THE NODE: the origin board POSTs a
 * card here, polls its state and comments, pulls the delivery branch back as
 * a git bundle, and deletes the run when it buries it (KANBAN-77).
 *
 * The mirror is an ordinary local task: same service, same dispatcher, same
 * board. What this router adds is the mapping between the two machines:
 *   - the PROJECT is resolved by git origin, never by id or path. The board's
 *     project id is a hash of a path that does not exist here, so a lookup by
 *     id would always miss and a lookup by path would create phantom projects.
 *   - the RUN id is the node-local task id, and the origin task id is kept as
 *     the task's idempotency key, so a retried POST finds its own card.
 *
 * Every route is owner-only: a node is paired as a DEVICE of the node
 * (MACHINE-02), and the origin board holds an owner token. A guest device
 * would otherwise be able to plant cards on somebody else's board.
 */
import type { AppContext, RouteHandler } from "../types";
import { createTaskService, TaskServiceError, type Task } from "../services/tasks";
import { defaultRunGit, type GitRunner } from "../services/own-commits";

const RUN_KEY_PREFIX = "node-run:";

export interface NodesRouterOpts {
  /** Injectable git, so a test can answer `remote get-url` without a repository. */
  runGit?: GitRunner;
  /**
   * The board's own DELETE of a card (stop the live agent, THEN archive).
   * Delegated instead of copied: `detachLiveAgent` lives inside the tasks
   * router, and an archive that skips it leaves an agent working for a card
   * that no longer exists (the defect the tasks router documents).
   */
  deleteBoardTask: (projectId: string, taskId: string) => ReturnType<RouteHandler>;
  /** The dispatcher's "vai" signal for a card born in `todo`. */
  onEnterTodo?: (projectId: string, taskId: string) => void;
}

/**
 * `git@host:owner/repo.git`, `ssh://git@host/owner/repo` and
 * `https://host/owner/repo.git` are the same repository. The comparison key is
 * `host/owner/repo`, lowercased: GitHub treats owner and repo names as case
 * insensitive, and two machines routinely clone the same repo over different
 * transports. Returns null for anything that is not a remote URL (a local
 * path, an empty remote).
 */
function normalizeRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(s);
      if (!u.hostname) return null;
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return s || null;
}

/**
 * Where a delivery branch forked from, and how much is on it. `baseSha` is the
 * merge base with the default branch: it is what the origin board must already
 * have for the bundle to apply, and what it plants an empty branch on when the
 * card produced no commits.
 */
interface DeliveryFacts {
  baseSha: string | null;
  commitCount: number;
}

async function defaultBranchOf(runGit: GitRunner, repoPath: string): Promise<string> {
  const head = await runGit(repoPath, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  const remoteHead = head.stdout.trim();
  if (head.code === 0 && remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    const r = await runGit(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${candidate}`]);
    if (r.code === 0) return candidate;
  }
  return "main";
}

async function deliveryFacts(runGit: GitRunner, repoPath: string, branch: string | null): Promise<DeliveryFacts> {
  const base = await defaultBranchOf(runGit, repoPath);
  const branchExists = branch
    ? (await runGit(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0
    : false;
  if (!branch || !branchExists) {
    const tip = await runGit(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${base}`]);
    return { baseSha: tip.code === 0 ? tip.stdout.trim() || null : null, commitCount: 0 };
  }
  const mb = await runGit(repoPath, ["merge-base", `refs/heads/${base}`, `refs/heads/${branch}`]);
  if (mb.code !== 0) return { baseSha: null, commitCount: 0 };
  const baseSha = mb.stdout.trim();
  const count = await runGit(repoPath, ["rev-list", "--count", `${baseSha}..refs/heads/${branch}`]);
  return { baseSha, commitCount: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0 };
}

function statOf(task: Task): { filesChanged: number; insertions: number; deletions: number } | null {
  if (task.deliveryFilesChanged === null || task.deliveryInsertions === null || task.deliveryDeletions === null) return null;
  return { filesChanged: task.deliveryFilesChanged, insertions: task.deliveryInsertions, deletions: task.deliveryDeletions };
}

export function createNodesRouter(ctx: AppContext, opts: NodesRouterOpts): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, projectStore, broadcastToAll } = ctx;
  const runGit = opts.runGit ?? defaultRunGit;
  const svc = createTaskService(db);

  const fail = (e: unknown): Response => {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 400);
    throw e;
  };

  /**
   * The local project whose `origin` is the given remote. Walks the live
   * projects and asks git, one at a time: a project whose folder is gone or
   * has no remote simply does not match. Never creates anything.
   */
  async function projectForOrigin(originKey: string): Promise<{ id: string; path: string } | null> {
    for (const p of projectStore.list({ archived: false })) {
      const r = await runGit(p.path, ["remote", "get-url", "origin"]);
      if (r.code !== 0) continue;
      if (normalizeRemoteUrl(r.stdout) === originKey) return { id: p.id, path: p.path };
    }
    return null;
  }

  function repoPathOf(task: Task): string | null {
    return projectStore.get(task.projectId)?.path ?? null;
  }

  return async function nodesRouter(req, url, pathname, method) {
    if (!pathname.startsWith("/api/nodes/")) return null;

    // `null` identity means loopback or an exempt path: owner by definition,
    // the same reading every other router gives it. Only a resolved guest is
    // turned away.
    const identity = ctx.requestIdentity?.(req) ?? null;
    if (identity && identity.role !== "owner") {
      return json({ error: "owner device required", code: "owner_required" }, 403);
    }

    if (method === "POST" && pathname === "/api/nodes/runs") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");
      const originTaskId = stripCtrl(body.originTaskId);
      const text = stripCtrl(body.text);
      if (!originTaskId) return errorResponse(400, "originTaskId required");
      if (!text) return errorResponse(400, "text required");
      const originKey = normalizeRemoteUrl(body.originUrl);
      if (!originKey) return errorResponse(400, "originUrl must be a git remote URL");

      const project = await projectForOrigin(originKey);
      if (!project) return json({ error: "no_such_repo", originUrl: body.originUrl }, 404);

      // One mirror per origin card. The key lives in `claude_task_id` (UNIQUE):
      // a live mirror is returned as is, an ARCHIVED one gives its key back so
      // the new run gets a fresh card. Without the release the UNIQUE index
      // would make every rerun after a DELETE (KANBAN-77) fail with a
      // constraint error instead of starting.
      const key = RUN_KEY_PREFIX + originTaskId;
      const prior = db.query("SELECT id, project_id, archived FROM tasks WHERE claude_task_id = ?").get(key) as
        | { id: string; project_id: string; archived: number }
        | null;
      if (prior && prior.archived === 0) {
        return json({ runId: prior.id, projectId: prior.project_id });
      }
      if (prior) db.run("UPDATE tasks SET claude_task_id = NULL WHERE id = ?", [prior.id]);

      try {
        const task = svc.create({
          projectId: project.id,
          text,
          description: typeof body.description === "string" ? body.description : null,
          status: "todo",
          model: typeof body.model === "string" ? body.model : null,
          idempotencyKey: key,
        });
        svc.addComment({
          taskId: task.id,
          author: "system",
          kind: "service",
          content: `Card specchiata da ${originKey} (task ${originTaskId}).`, // allow-italian: board notes are written in Italian like every other service comment
          projectId: project.id,
        });
        broadcastToAll({ type: "task:created", projectId: project.id, task });
        opts.onEnterTodo?.(project.id, task.id);
        return json({ runId: task.id, projectId: project.id }, 201);
      } catch (e) {
        return fail(e);
      }
    }

    const bundle = matchRoute(pathname, "/api/nodes/runs/:id/bundle");
    if (bundle && method === "GET") {
      const got = svc.get(bundle.id);
      if (!got) return json({ error: "run not found", code: "not_found" }, 404);
      const repoPath = repoPathOf(got.task);
      if (!repoPath) return json({ error: "project of the run has no checkout", code: "repo_unresolved" }, 409);
      const branch = got.task.deliveryBranch;
      // A ref that starts with "-" would be read by git as an option. The
      // value comes from our own row, but a bundle is the one place where a
      // stray name turns into a flag on a subprocess.
      if (branch && branch.startsWith("-")) return json({ error: "invalid delivery branch", code: "invalid_input" }, 400);
      const facts = await deliveryFacts(runGit, repoPath, branch);
      if (!branch || facts.commitCount === 0 || !facts.baseSha) {
        return json({ empty: true, baseSha: facts.baseSha });
      }
      // Only the commits past the fork point, by construction: `--not
      // <baseSha>` is what keeps the bundle small and what makes a missing
      // base on the receiving side a declared failure instead of a silent
      // full-history download.
      const proc = Bun.spawn(["git", "-C", repoPath, "bundle", "create", "-", `refs/heads/${branch}`, "--not", facts.baseSha], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return new Response(proc.stdout, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-topics-base-sha": facts.baseSha,
          "x-topics-delivery-branch": branch,
        },
      });
    }

    const run = matchRoute(pathname, "/api/nodes/runs/:id");
    if (run) {
      if (method === "GET") {
        const got = svc.get(run.id);
        if (!got) return json({ error: "run not found", code: "not_found" }, 404);
        const { task } = got;
        // `?since=<createdAt>`: comments created AT OR AFTER that instant. The
        // bound is inclusive on purpose: two comments can share a millisecond,
        // and an exclusive cursor would drop the second one for good. The
        // caller dedupes by `id`, which is the stable key it already stores.
        const since = url.searchParams.get("since");
        const comments = got.comments
          .filter((c) => !since || c.createdAt >= since)
          .map((c) => ({ id: c.id, author: c.author, content: c.content, kind: c.kind, createdAt: c.createdAt }));
        const repoPath = repoPathOf(task);
        const facts = repoPath ? await deliveryFacts(runGit, repoPath, task.deliveryBranch) : { baseSha: null, commitCount: 0 };
        return json({
          runId: task.id,
          status: task.status,
          dispatchState: task.dispatchState,
          dispatchError: task.dispatchError,
          comments,
          deliveryBranch: task.deliveryBranch,
          deliveryCommit: task.deliveryCommit,
          baseSha: facts.baseSha,
          commitCount: facts.commitCount,
          stat: statOf(task),
        });
      }
      if (method === "DELETE") {
        const got = svc.get(run.id);
        if (!got) return json({ error: "run not found", code: "not_found" }, 404);
        // Idempotent by delegation: the board's DELETE archives an archived
        // subtree again without complaint, and finds no live agent to cut.
        const resp = await opts.deleteBoardTask(got.task.projectId, got.task.id);
        if (!resp) return json({ error: "board delete unavailable", code: "internal" }, 500);
        if (!resp.ok) return resp;
        return json({ ok: true, runId: got.task.id });
      }
    }

    return null;
  };
}
