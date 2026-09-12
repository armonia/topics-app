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
 * Legacy mirrored runs remain owner-only. Delegated runs use a separate,
 * capability-bound credential minted by the execution computer after its
 * installation owner approves the checkout and policy.
 */
import type { AppContext, RouteHandler } from "../types";
import { createTaskService, TaskServiceError, type Task } from "../services/tasks";
import { defaultRunGit, type GitRunner } from "../services/own-commits";
import type { DelegatedNodeBinding } from "../services/node-client";
import { actingPersonId } from "../lib/orgs";
import { hashToken, mintSessionToken, buildSessionCookie } from "../lib/device-auth";
import { availableTaskModels } from "../../shared/task-coding-models";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { isLoopbackAddress } from "../lib/auth-gate";
import { isLocalTransport } from "../lib/tunnel";
import { createDelegatedRevocationRetry, type DelegatedRevocationRetry } from "../services/delegated-revocation-retry";

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
  /** The dispatcher go-ahead for a card that is born in `todo`. */
  onEnterTodo?: (projectId: string, taskId: string) => void;
  /** Runtime-ready coding models on this node; injectable for two-installation tests. */
  taskModels?: () => string[];
  /** Shared server-side retry loop; tests may omit it and get the same service locally. */
  revocations?: DelegatedRevocationRetry;
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
  const revocations = opts.revocations ?? createDelegatedRevocationRetry({
    db,
    deleteBoardTask: opts.deleteBoardTask,
  });

  const installationOwner = (req: Request): string | null => {
    const identity = ctx.requestIdentity?.(req) ?? null;
    if (!identity) {
      if (!isLocalTransport(req, ctx.requestIp?.(req) ?? null, isLoopbackAddress)) return null;
      return (db.query("SELECT person_id FROM installation_owners ORDER BY is_default DESC LIMIT 1").get() as
        | { person_id: string } | null)?.person_id ?? null;
    }
    // The global gate materialises loopback as a synthetic owner identity with
    // no device row. It is the only device-less identity that may act here;
    // an explicit guest remains a guest even in an in-process route test.
    if (identity.role === "owner" && identity.deviceId === null) {
      return (db.query("SELECT person_id FROM installation_owners ORDER BY is_default DESC LIMIT 1").get() as
        | { person_id: string } | null)?.person_id ?? null;
    }
    if (!identity.deviceId || identity.role !== "owner") return null;
    const personId = actingPersonId(db as never, identity.deviceId);
    if (!personId) return null;
    return db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(personId) ? personId : null;
  };

  const delegatedAuthorizationId = (req: Request): string | null => {
    const identity = ctx.requestIdentity?.(req) as ({ role?: string; delegatedAuthorizationId?: string } | null | undefined);
    return identity?.role === "guest" && typeof identity.delegatedAuthorizationId === "string"
      ? identity.delegatedAuthorizationId : null;
  };

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

  type NodeAuthorization = DelegatedNodeBinding & {
    authorizationId: string;
    expiresAt: number | null;
  };

  function nodeAuthorization(req: Request, repositoryKey: string): NodeAuthorization | null {
    const authorizationId = delegatedAuthorizationId(req);
    const capabilityId = req.headers.get("X-Topics-Delegated-Capability")?.trim() ?? "";
    if (!authorizationId || !capabilityId) return null;
    const now = Date.now();
    const row = db.query(`SELECT a.id, a.capability_id, a.subject_person_id, a.subject_device_id,
        a.machine_id, a.repository_key, a.model, a.effort, a.max_duration_minutes,
        a.max_attempts, a.fanout, a.expires_at
      FROM delegated_node_authorizations a
      WHERE a.id = ? AND a.capability_id = ?
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?)`)
      .get(authorizationId, capabilityId, now) as {
        id: string; capability_id: string; subject_person_id: string | null; subject_device_id: string;
        machine_id: string; repository_key: string; model: string; effort: string;
        max_duration_minutes: number; max_attempts: 1; fanout: 1; expires_at: number | null;
      } | null;
    if (!row || row.repository_key !== repositoryKey) return null;
    if (!repositoryAuthorized(row.machine_id, row.repository_key)) return null;
    return {
      authorizationId: row.id,
      capabilityId: row.capability_id,
      subjectPersonId: row.subject_person_id,
      subjectDeviceId: row.subject_device_id,
      machineId: row.machine_id,
      repositoryKey: row.repository_key,
      model: row.model,
      effort: row.effort,
      maxDurationMinutes: row.max_duration_minutes,
      maxAttempts: row.max_attempts,
      fanout: row.fanout,
      expiresAt: row.expires_at,
    };
  }

  function repositoryAuthorized(machineId: string, repositoryKey: string): boolean {
    try {
      return !!db.query(`SELECT 1 FROM machine_repository_authorizations
        WHERE machine_id = ? AND repository_key = ? AND revoked_at IS NULL LIMIT 1`)
        .get(machineId, repositoryKey);
    } catch {
      return false;
    }
  }

  function storedDelegatedBinding(runId: string): (DelegatedNodeBinding & {
    projectId: string;
    authorizationId: string;
  }) | null {
    try {
      const row = db.query(`SELECT n.authorization_id, n.capability_id, n.subject_person_id,
          n.subject_device_id, n.project_id, n.machine_id, n.repository_key, n.model, n.effort,
          n.max_duration_minutes, n.max_attempts, n.fanout, n.expires_at, n.revoked_at,
          n.deadline_at, a.revoked_at AS authorization_revoked_at, a.expires_at AS authorization_expires_at,
          a.capability_id AS authorization_capability_id, a.subject_person_id AS authorization_person_id,
          a.subject_device_id AS authorization_device_id, a.machine_id AS authorization_machine_id,
          a.repository_key AS authorization_repository_key, a.model AS authorization_model,
          a.effort AS authorization_effort, a.max_duration_minutes AS authorization_duration,
          a.max_attempts AS authorization_attempts, a.fanout AS authorization_fanout
        FROM delegated_node_runs n
        JOIN delegated_node_authorizations a ON a.id = n.authorization_id
        WHERE n.run_id = ?`).get(runId) as {
          authorization_id: string; capability_id: string; subject_person_id: string | null;
          subject_device_id: string; project_id: string; machine_id: string; repository_key: string;
          model: string; effort: string; max_duration_minutes: number; max_attempts: 1; fanout: 1;
          expires_at: number | null; revoked_at: number | null; deadline_at: number;
          authorization_revoked_at: number | null; authorization_expires_at: number | null;
          authorization_capability_id: string; authorization_person_id: string | null;
          authorization_device_id: string; authorization_machine_id: string;
          authorization_repository_key: string; authorization_model: string; authorization_effort: string;
          authorization_duration: number; authorization_attempts: number; authorization_fanout: number;
        } | null;
      if (!row) return null;
      const snapshotMatches = row.capability_id === row.authorization_capability_id
        && row.subject_person_id === row.authorization_person_id
        && row.subject_device_id === row.authorization_device_id
        && row.machine_id === row.authorization_machine_id
        && row.repository_key === row.authorization_repository_key
        && row.model === row.authorization_model
        && row.effort === row.authorization_effort
        && row.max_duration_minutes === row.authorization_duration
        && row.max_attempts === row.authorization_attempts
        && row.fanout === row.authorization_fanout;
      if (!snapshotMatches) return null;
      const now = Date.now();
      const expired = row.deadline_at <= now
        || (row.expires_at !== null && row.expires_at <= now)
        || (row.authorization_expires_at !== null && row.authorization_expires_at <= now);
      if (row.revoked_at !== null || row.authorization_revoked_at !== null || expired) {
        db.query("UPDATE delegated_node_runs SET revoked_at = COALESCE(revoked_at, ?) WHERE run_id = ?").run(now, runId);
        return null;
      }
      return {
        authorizationId: row.authorization_id,
        capabilityId: row.capability_id,
        subjectPersonId: row.subject_person_id,
        subjectDeviceId: row.subject_device_id,
        projectId: row.project_id,
        machineId: row.machine_id,
        repositoryKey: row.repository_key,
        model: row.model,
        effort: row.effort,
        maxDurationMinutes: row.max_duration_minutes,
        maxAttempts: row.max_attempts,
        fanout: row.fanout,
      };
    } catch {
      return null;
    }
  }

  async function confinedRun(req: Request, runId: string): Promise<Task | null> {
    const binding = storedDelegatedBinding(runId);
    if (!binding) return null;
    if (delegatedAuthorizationId(req) !== binding.authorizationId
      || req.headers.get("X-Topics-Delegated-Capability") !== binding.capabilityId
      || !repositoryAuthorized(binding.machineId, binding.repositoryKey)) return null;
    const got = svc.get(runId)?.task;
    if (!got || got.projectId !== binding.projectId) return null;
    const path = repoPathOf(got);
    if (!path) return null;
    const origin = await runGit(path, ["remote", "get-url", "origin"]);
    return origin.code === 0 && normalizeRemoteUrl(origin.stdout) === binding.repositoryKey ? got : null;
  }
  return async function nodesRouter(req, url, pathname, method) {
    if (!pathname.startsWith("/api/nodes/")) return null;

    const confined = pathname.startsWith("/api/nodes/delegated-runs");
    const identity = ctx.requestIdentity?.(req) ?? null;
    if (pathname === "/api/nodes/delegated-requests" && method === "POST") {
      const body = await readJSON(req) as Record<string, unknown> | null;
      const purpose = body?.purpose === "catalog" ? "catalog" : body?.purpose === "authorization" ? "authorization" : null;
      const capabilityId = stripCtrl(body?.capabilityId);
      const repositoryKey = stripCtrl(body?.repositoryKey);
      const originPersonId = body?.originPersonId === null ? null : stripCtrl(body?.originPersonId);
      const originDeviceId = stripCtrl(body?.originDeviceId);
      const originMachineId = stripCtrl(body?.originMachineId);
      const model = stripCtrl(body?.model);
      const effort = stripCtrl(body?.effort);
      const maxDurationMinutes = body?.maxDurationMinutes;
      const invalidAuthorization = purpose === "authorization" && (!capabilityId || !originDeviceId || !model || !effort
        || (body?.originPersonId !== null && !originPersonId)
        || !Number.isInteger(maxDurationMinutes) || (maxDurationMinutes as number) < 1
        || (maxDurationMinutes as number) > 1440);
      if (!purpose || !repositoryKey || !originMachineId || invalidAuthorization) {
        return json({ error: "invalid delegated request", code: "invalid_input" }, 400);
      }
      const now = Date.now();
      const expiresAt = now + 3 * 60_000;
      const requestId = crypto.randomUUID();
      const claim = mintSessionToken();
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
      db.query(`INSERT INTO delegated_node_requests
        (id,direction,purpose,remote_request_id,claim_hash,code,state,machine_id,capability_id,repository_key,
         origin_person_id,origin_device_id,model,effort,max_duration_minutes,expires_at,created_at,updated_at)
        VALUES (?,'node',?,?, ?,?,'pending',?,?,?,?,?,?,?,?,?,?,?)`).run(
        requestId, purpose, requestId, hashToken(claim), code, originMachineId, capabilityId, repositoryKey,
        originPersonId, originDeviceId ?? "catalog", model, effort,
        typeof maxDurationMinutes === "number" ? maxDurationMinutes : null, expiresAt, now, now,
      );
      broadcastToAll({ type: "auth:pair-requested", requestId, code, name: "Richiesta computer remoto", ip: null, purpose: "delegated-node" });
      return json({ requestId, claim, code, expiresInMs: expiresAt - now }, 201);
    }
    if (pathname === "/api/nodes/delegated-requests" && method === "GET") {
      if (!installationOwner(req)) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const now = Date.now();
      db.query(`UPDATE delegated_node_requests SET state='expired', updated_at=?
        WHERE direction='node' AND state='pending' AND expires_at <= ?`).run(now, now);
      const requests = db.query(`SELECT id,purpose,code,state,capability_id AS capabilityId,repository_key AS repositoryKey,
          origin_person_id AS originPersonId,model,effort,max_duration_minutes AS maxDurationMinutes,
          expires_at AS expiresAt,authorization_id AS authorizationId,local_project_id AS localProjectId,local_person_id AS localPersonId,
          revoke_pending AS revokePending,last_error AS lastError
        FROM delegated_node_requests WHERE direction='node' ORDER BY created_at DESC`).all();
      return json({ requests });
    }
    const ownerRevocation = matchRoute(pathname, "/api/nodes/delegated-requests/:id/owner-revoke");
    if (ownerRevocation && method === "DELETE") {
      if (!installationOwner(req)) return json({ error: "installation owner required", code: "owner_required" }, 403);
      pathname = `/api/nodes/delegated-requests/${encodeURIComponent(ownerRevocation.id)}`;
    }
    const delegatedRequest = matchRoute(pathname, "/api/nodes/delegated-requests/:id");
    if (delegatedRequest) {
      const row = db.query("SELECT * FROM delegated_node_requests WHERE id=? AND direction='node'").get(delegatedRequest.id) as Record<string, any> | null;
      if (!row) return json({ error: "request not found", code: "not_found" }, 404);
      const now = Date.now();
      if (method === "POST" && pathname.endsWith("/approve")) return null;
      if (method === "DELETE") {
        const requestIdentity = ctx.requestIdentity?.(req) ?? null;
        const local = requestIdentity === null
          && (!ctx.requestIp || isLocalTransport(req, ctx.requestIp(req), isLoopbackAddress));
        const owner = requestIdentity !== null || local ? installationOwner(req) : null;
        const authId = delegatedAuthorizationId(req);
        const claim = url.searchParams.get("claim") ?? "";
        const claimed = claim && hashToken(claim) === row.claim_hash;
        if (!owner && (!authId || authId !== row.authorization_id) && !claimed) {
          return json({ error: "delegated request denied", code: "unauthorized" }, 403);
        }
        db.transaction(() => {
          if (row.authorization_id) {
            db.query("UPDATE delegated_node_authorizations SET revoked_at=COALESCE(revoked_at,?),revoked_by_person_id=COALESCE(revoked_by_person_id,?) WHERE id=?")
              .run(now, owner, row.authorization_id);
            db.query(`UPDATE delegated_node_runs SET revoked_at=COALESCE(revoked_at,?),cancel_requested_at=COALESCE(cancel_requested_at,?)
              WHERE authorization_id=?`).run(now, now, row.authorization_id);
            db.query("UPDATE delegated_node_requests SET revoke_pending=1,last_error=NULL,updated_at=? WHERE id=?")
              .run(now, row.id);
          } else {
            db.query("UPDATE delegated_node_requests SET state='revoked',revoke_pending=0,last_error=NULL,updated_at=? WHERE id=?")
              .run(now, row.id);
          }
        })();
        if (row.authorization_id) {
          await revocations.tick({ requestId: row.id, force: true });
          const pending = !!db.query("SELECT 1 FROM delegated_node_requests WHERE id=? AND revoke_pending=1").get(row.id);
          if (pending) {
            broadcastToAll({ type: "auth:pair-resolved", requestId: row.id, approved: false, purpose: "delegated-node" });
            return json({ error: "delegated run cancellation is not confirmed", code: "delegated_cancel_unconfirmed", retryPending: true }, 503);
          }
        }
        broadcastToAll({ type: "auth:pair-resolved", requestId: row.id, approved: false, purpose: "delegated-node" });
        return json({ ok: true });
      }
    }

    const approveRequest = matchRoute(pathname, "/api/nodes/delegated-requests/:id/approve");
    if (approveRequest && method === "POST") {
      const owner = installationOwner(req);
      if (!owner) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const body = await readJSON(req) as Record<string, unknown> | null;
      const projectId = stripCtrl(body?.projectId);
      const requestedPerson = body?.localPersonId == null ? owner : stripCtrl(body.localPersonId);
      if (!projectId || requestedPerson !== owner) return json({ error: "local owner identity required", code: "owner_required" }, 403);
      const row = db.query("SELECT * FROM delegated_node_requests WHERE id=? AND direction='node'").get(approveRequest.id) as Record<string, any> | null;
      if (!row) return json({ error: "request not found", code: "not_found" }, 404);
      if (row.state !== "pending" || row.expires_at <= Date.now()) return json({ error: "request is not pending", code: "not_pending" }, 409);
      const project = ctx.projectStore.get(projectId);
      if (!project) return json({ error: "checkout not found", code: "not_found" }, 404);
      const remote = await runGit(project.path, ["remote", "get-url", "origin"]);
      if (remote.code !== 0 || normalizeRemoteUrl(remote.stdout) !== row.repository_key) {
        return json({ error: "checkout repository mismatch", code: "repository_mismatch" }, 409);
      }
      const localMachine = ctx.machineStore.upsertLocal();
      const now = Date.now();
      const nodeModels = opts.taskModels?.() ?? availableTaskModels(getSnapshotManager().getSnapshot());
      if (row.purpose === "catalog") {
        db.query(`UPDATE delegated_node_requests SET state='approved',local_project_id=?,local_person_id=?,
          expires_at=?,updated_at=? WHERE id=?`).run(projectId, owner, now + 10 * 60_000, now, row.id);
        broadcastToAll({ type: "auth:pair-resolved", requestId: row.id, approved: true, purpose: "delegated-node" });
        return json({ ok: true, state: "approved" });
      }
      if (!nodeModels.includes(row.model)) {
        return json({ error: "coding model unavailable on this computer", code: "model_unavailable" }, 409);
      }
      const priorAuthorization = db.query("SELECT id FROM delegated_node_authorizations WHERE capability_id=?")
        .get(row.capability_id) as { id: string } | null;
      const authorizationId = priorAuthorization?.id ?? crypto.randomUUID();
      const repoAuthId = crypto.randomUUID();
      const expiresAt = Math.min(row.expires_at + 24 * 60 * 60_000, Date.now() + 24 * 60 * 60_000);
      db.transaction(() => {
        db.query(`INSERT INTO machine_repository_authorizations
          (id,machine_id,repository_key,authorized_by_person_id,authorized_at)
          VALUES (?,?,?,?,?) ON CONFLICT(machine_id,repository_key) WHERE revoked_at IS NULL DO NOTHING`)
          .run(repoAuthId, localMachine.id, row.repository_key, owner, now);
        if (priorAuthorization) {
          db.query("UPDATE delegated_node_runs SET revoked_at=COALESCE(revoked_at,?) WHERE authorization_id=?")
            .run(now, authorizationId);
          db.query(`UPDATE delegated_node_authorizations SET credential_hash=?,subject_person_id=?,subject_device_id=?,
            machine_id=?,repository_key=?,model=?,effort=?,max_duration_minutes=?,authorized_by_person_id=?,
            authorized_at=?,expires_at=?,revoked_at=NULL,revoked_by_person_id=NULL WHERE id=?`).run(
            hashToken(mintSessionToken()), row.origin_person_id, row.origin_device_id, localMachine.id,
            row.repository_key, row.model, row.effort, row.max_duration_minutes, owner, now, expiresAt, authorizationId,
          );
          db.query("UPDATE delegated_node_requests SET state='revoked',updated_at=? WHERE authorization_id=? AND id<>?")
            .run(now, authorizationId, row.id);
        } else {
          db.query(`INSERT INTO delegated_node_authorizations
            (id,capability_id,credential_hash,subject_person_id,subject_device_id,machine_id,repository_key,
             model,effort,max_duration_minutes,max_attempts,fanout,authorized_by_person_id,authorized_at,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)`).run(
            authorizationId, row.capability_id, hashToken(mintSessionToken()), row.origin_person_id,
            row.origin_device_id, localMachine.id, row.repository_key, row.model, row.effort,
            row.max_duration_minutes, owner, now, expiresAt,
          );
        }
        db.query(`UPDATE delegated_node_requests SET state='approved',authorization_id=?,local_project_id=?,
          local_person_id=?,expires_at=?,updated_at=? WHERE id=?`).run(
          authorizationId, projectId, owner, expiresAt, now, row.id,
        );
      })();
      broadcastToAll({ type: "auth:pair-resolved", requestId: row.id, approved: true, purpose: "delegated-node" });
      return json({ ok: true, state: "approved" });
    }

    const denyRequest = matchRoute(pathname, "/api/nodes/delegated-requests/:id/deny");
    if (denyRequest && method === "POST") {
      if (!installationOwner(req)) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const changed = db.query("UPDATE delegated_node_requests SET state='denied',updated_at=? WHERE id=? AND direction='node' AND state='pending'")
        .run(Date.now(), denyRequest.id).changes;
      if (changed) broadcastToAll({ type: "auth:pair-resolved", requestId: denyRequest.id, approved: false, purpose: "delegated-node" });
      return changed ? json({ ok: true, state: "denied" }) : json({ error: "request is not pending", code: "not_pending" }, 409);
    }

    const claimRequest = matchRoute(pathname, "/api/nodes/delegated-requests/:id/claim");
    if (claimRequest && method === "GET") {
      const claim = url.searchParams.get("claim") ?? "";
      const row = db.query("SELECT * FROM delegated_node_requests WHERE id=? AND direction='node'").get(claimRequest.id) as Record<string, any> | null;
      if (!row || !claim || hashToken(claim) !== row.claim_hash) return json({ error: "claim denied", code: "unauthorized" }, 403);
      if (row.state === "pending" && row.expires_at <= Date.now()) {
        db.query("UPDATE delegated_node_requests SET state='expired',updated_at=? WHERE id=?").run(Date.now(), row.id);
        return json({ state: "expired" });
      }
      if (row.state === "pending") return json({ state: "pending" });
      if (row.purpose === "catalog") {
        if (row.state !== "approved" || row.expires_at <= Date.now()) return json({ state: row.state === "approved" ? "expired" : row.state });
        const models = opts.taskModels?.() ?? availableTaskModels(getSnapshotManager().getSnapshot());
        return json({ state: "approved", expiresAt: row.expires_at, models });
      }
      if (row.state !== "approved" || row.expires_at <= Date.now() || !row.authorization_id) return json({ state: row.state === "approved" ? "expired" : row.state });
      const token = mintSessionToken();
      const rotated = db.query("UPDATE delegated_node_authorizations SET credential_hash=? WHERE id=? AND revoked_at IS NULL AND expires_at>?")
        .run(hashToken(token), row.authorization_id, Date.now()).changes;
      if (!rotated) return json({ state: "revoked" });
      const models = opts.taskModels?.() ?? availableTaskModels(getSnapshotManager().getSnapshot());
      return new Response(JSON.stringify({
        state: "approved", authorizationId: row.authorization_id, expiresAt: row.expires_at, models,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": buildSessionCookie(token, {
            secure: new URL(req.url).protocol === "https:",
            maxAgeMs: Math.max(1, row.expires_at - Date.now()),
          }),
        },
      });
    }

    const ackRequest = matchRoute(pathname, "/api/nodes/delegated-requests/:id/ack");
    if (ackRequest && method === "POST") {
      const claim = url.searchParams.get("claim") ?? "";
      const changed = db.query(`UPDATE delegated_node_requests SET state='active',updated_at=?
        WHERE id=? AND direction='node' AND state IN ('approved','active') AND claim_hash=?`).run(Date.now(), ackRequest.id, hashToken(claim)).changes;
      if (changed) broadcastToAll({ type: "auth:pair-resolved", requestId: ackRequest.id, approved: true, purpose: "delegated-node" });
      return changed ? json({ ok: true, state: "active" }) : json({ error: "ack denied", code: "unauthorized" }, 403);
    }
    if (!confined && identity && identity.role !== "owner") {
      return json({ error: "owner device required", code: "owner_required" }, 403);
    }

    if (confined && (!identity || identity.role !== "guest" || !delegatedAuthorizationId(req))) {
      return json({ error: "delegated credential required", code: "delegated_credential_required" }, 403);
    }

    if (method === "POST" && pathname === "/api/nodes/delegated-runs") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");
      const forbidden = ["capabilityId", "machineId", "model", "effort", "maxDurationMinutes", "maxAttempts", "fanout", "delegation"];
      if (forbidden.some((key) => Object.hasOwn(body, key))) {
        return json({ error: "execution policy is derived by the node", code: "delegated_policy_in_body" }, 400);
      }
      const originTaskId = stripCtrl(body.originTaskId);
      const text = stripCtrl(body.text);
      const originKey = normalizeRemoteUrl(body.originUrl);
      if (!originTaskId || !text || !originKey) return errorResponse(400, "invalid delegated run input");
      const binding = nodeAuthorization(req, originKey);
      if (!binding) return json({ error: "delegated run denied", code: "delegated_run_denied" }, 403);
      const project = await projectForOrigin(originKey);
      if (!project) return json({ error: "delegated run denied", code: "delegated_run_denied" }, 403);

      const prior = db.query(`SELECT run_id FROM delegated_node_runs
        WHERE origin_task_id = ? AND capability_id = ?`).get(originTaskId, binding.capabilityId) as { run_id: string } | null;
      if (prior) {
        const task = await confinedRun(req, prior.run_id);
        if (!task) return json({ error: "run not found", code: "not_found" }, 404);
        return json({ runId: task.id, projectId: task.projectId });
      }

      try {
        const task = db.transaction(() => {
          const created = svc.create({
            projectId: project.id,
            text,
            description: typeof body.description === "string" ? body.description : null,
            status: "todo",
            model: binding.model,
            idempotencyKey: `${RUN_KEY_PREFIX}delegated:${binding.capabilityId}:${originTaskId}`,
          });
          db.query(`INSERT INTO delegated_node_runs
            (run_id, origin_task_id, project_id, capability_id, authorization_id, subject_person_id,
             subject_device_id, machine_id, repository_key, model, effort,
             max_duration_minutes, max_attempts, fanout, expires_at, deadline_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            created.id, originTaskId, project.id, binding.capabilityId, binding.authorizationId, binding.subjectPersonId,
            binding.subjectDeviceId, binding.machineId, binding.repositoryKey, binding.model,
            binding.effort, binding.maxDurationMinutes, binding.maxAttempts, binding.fanout,
            binding.expiresAt, Math.min(
              Date.now() + binding.maxDurationMinutes * 60_000,
              binding.expiresAt ?? Number.POSITIVE_INFINITY,
            ), Date.now(),
          );
          return created;
        })();
        broadcastToAll({ type: "task:created", projectId: project.id, task });
        opts.onEnterTodo?.(project.id, task.id);
        return json({ runId: task.id, projectId: project.id }, 201);
      } catch (e) {
        return fail(e);
      }
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

    const delegatedBundle = matchRoute(pathname, "/api/nodes/delegated-runs/:id/bundle");
    if (delegatedBundle && method === "GET") {
      const task = await confinedRun(req, delegatedBundle.id);
      if (!task) return json({ error: "run not found", code: "not_found" }, 404);
      const repoPath = repoPathOf(task)!;
      const branch = task.deliveryBranch;
      if (branch && branch.startsWith("-")) return json({ error: "invalid delivery branch", code: "invalid_input" }, 400);
      const facts = await deliveryFacts(runGit, repoPath, branch);
      if (!branch || facts.commitCount === 0 || !facts.baseSha) return json({ empty: true, baseSha: facts.baseSha });
      const proc = Bun.spawn(["git", "-C", repoPath, "bundle", "create", "-", `refs/heads/${branch}`, "--not", facts.baseSha], {
        stdout: "pipe", stderr: "pipe",
      });
      return new Response(proc.stdout, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-topics-base-sha": facts.baseSha, "x-topics-delivery-branch": branch },
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


    const delegatedRun = matchRoute(pathname, "/api/nodes/delegated-runs/:id");
    if (delegatedRun) {
      const task = await confinedRun(req, delegatedRun.id);
      if (!task) return json({ error: "run not found", code: "not_found" }, 404);
      if (method === "GET") {
        const got = svc.get(task.id)!;
        const since = url.searchParams.get("since");
        const comments = got.comments
          .filter((comment) => !since || comment.createdAt >= since)
          .map((comment) => ({
            id: comment.id, author: comment.author, content: comment.content,
            kind: comment.kind, createdAt: comment.createdAt,
          }));
        const repoPath = repoPathOf(task)!;
        const facts = await deliveryFacts(runGit, repoPath, task.deliveryBranch);
        return json({
          runId: task.id, status: task.status, dispatchState: task.dispatchState,
          dispatchError: task.dispatchError, comments, deliveryBranch: task.deliveryBranch,
          deliveryCommit: task.deliveryCommit, baseSha: facts.baseSha,
          commitCount: facts.commitCount, stat: statOf(task),
        });
      }
      if (method === "DELETE") {
        const resp = await opts.deleteBoardTask(task.projectId, task.id);
        if (!resp) return json({ error: "board delete unavailable", code: "internal" }, 500);
        if (!resp.ok) return resp;
        db.query("UPDATE delegated_node_runs SET revoked_at = COALESCE(revoked_at, ?) WHERE run_id = ?")
          .run(Date.now(), task.id);
        return json({ ok: true, runId: task.id });
      }
    }

    return null;
  };
}
