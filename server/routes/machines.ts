/**
 * Routes — `/api/machines` (Phase D · migration 020)
 *
 * Plus the pairing of a NODE (MACHINE-02): `POST /api/machines/pair` opens the
 * handshake against the node's own `/api/auth/pair/*`, `GET
 * /api/machines/pair/:id` polls it once. The `claim` that can withdraw the
 * token and the token itself live only in this process: the client gets the
 * code to read out loud and, at the end, the `machines` row.
 */
import { hostname as osHostname } from "node:os";
import type { AppContext, RouteHandler } from "../types";
import type { OutboundType } from "../../shared/ws-outbound";
import { MachineInUseError } from "../services/machine-store";
import {
  createNodeClient, isNodeError, normalizeNodeBaseUrl, readDelegatedNodeToken, removeDelegatedNodeToken,
  writeDelegatedNodeToken, writeNodeToken,
  type NodeClient, type NodeFailureReason,
} from "../services/node-client";
import { SERVER_VERSION } from "../ws-capabilities";
import { actingPersonId } from "../lib/orgs";
import { normalizeRepositoryKey } from "../lib/delegated-agent-start";
import { projectIdForPath } from "../../shared/board";

const NAME_MAX = 200;

/** Revoke the origin half immediately and persist a node-side retry. */
export async function revokeRemoteDelegatedCapability(ctx: AppContext, capabilityId: string): Promise<void> {
  const rows = ctx.db.query(`SELECT id,base_url,remote_request_id,claim_secret,machine_id
    FROM delegated_node_requests WHERE direction='origin' AND purpose='authorization'
      AND capability_id=? AND state NOT IN ('revoked','denied','expired')`).all(capabilityId) as Array<Record<string, any>>;
  if (!rows.length) return;
  const client = ctx.nodeClient ?? createNodeClient({
    fetch: (input, init) => fetch(input, init), now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    version: SERVER_VERSION, hostname: osHostname(),
  });
  for (const row of rows) {
    ctx.db.query("UPDATE delegated_node_requests SET state='revoked',revoke_pending=1,updated_at=? WHERE id=?")
      .run(Date.now(), row.id);
    removeDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, capabilityId);
    try {
      await client.revokeDelegatedRequest({
        baseUrl: row.base_url, requestId: row.remote_request_id, claim: row.claim_secret,
      });
      ctx.db.query("UPDATE delegated_node_requests SET revoke_pending=0,last_error=NULL,updated_at=? WHERE id=?")
        .run(Date.now(), row.id);
    } catch (err) {
      ctx.db.query("UPDATE delegated_node_requests SET last_error=?,updated_at=? WHERE id=?")
        .run(String(err), Date.now(), row.id);
    }
  }
}

function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** What this process remembers about a handshake in flight. None of it goes to the client. */
interface PendingNodePairing {
  requestId: string;
  claim: string;
  baseUrl: string;
  expiresAt: number;
}

/**
 * The node answered, and it said no (or nothing). 502 for every upstream
 * failure: the client is not the one being refused, the node is refusing US,
 * and a 401/403 passed through would make the client open ITS OWN pairing
 * screen. The `code` carries the declared reason (see `NodeFailureReason`).
 */
const UPSTREAM_STATUS: Record<NodeFailureReason, number> = {
  unreachable: 502,
  tls_untrusted: 502,
  host_not_allowed: 502,
  unauthorized: 502,
  no_such_repo: 502,
  not_found: 502,
  server_error: 502,
};

export function createMachinesRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, machineStore, broadcastToAll } = ctx;
  const emit = (type: OutboundType, machine: unknown) =>
    broadcastToAll({ type, machine, payload_version: 1 });

  const nodeClient: NodeClient = ctx.nodeClient ?? createNodeClient({
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    version: SERVER_VERSION,
    hostname: osHostname(),
  });

  const pendingHandshakes = new Map<string, PendingNodePairing>();
  const installationOwner = (req: Request): string | null => {
    const identity = ctx.requestIdentity?.(req) ?? null;
    if (!identity) {
      return (ctx.db.query("SELECT person_id FROM installation_owners ORDER BY is_default DESC LIMIT 1").get() as
        | { person_id: string } | null)?.person_id ?? null;
    }
    if (identity.role !== "owner" || !identity.deviceId) return null;
    const personId = actingPersonId(ctx.db as never, identity.deviceId);
    return personId && ctx.db.query("SELECT 1 FROM installation_owners WHERE person_id=?").get(personId) ? personId : null;
  };
  const repositoryKeyOf = async (projectId: string): Promise<string | null> => {
    const project = ctx.projectStore.get(projectId) ?? ctx.projectStore.list({ archived: false })
      .find((candidate) => projectIdForPath(candidate.path) === projectId) ?? null;
    if (!project) return null;
    const proc = Bun.spawn(["git", "-C", project.path, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? normalizeRepositoryKey(output) : null;
  };
  const sweepHandshakes = () => {
    const now = Date.now();
    for (const [id, p] of pendingHandshakes) if (p.expiresAt <= now) pendingHandshakes.delete(id);
  };

  const nodeFailure = (err: unknown): Response | null => {
    if (!isNodeError(err)) return null;
    return json({ error: err.message, code: err.reason }, UPSTREAM_STATUS[err.reason]);
  };

  return async function machinesRouter(req, _url, pathname, method) {
    if (pathname === "/api/machines/delegated-requests" && method === "POST") {
      const owner = installationOwner(req);
      if (!owner) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const body = await readJSON(req) as Record<string, unknown> | null;
      const purpose = body?.purpose === "catalog" ? "catalog" : "authorization";
      const machineId = stripCtrl(body?.machineId);
      const capabilityId = stripCtrl(body?.capabilityId);
      if (!machineId || (purpose === "authorization" && !capabilityId)) {
        return json({ error: purpose === "catalog" ? "machineId required" : "machineId and capabilityId required", code: "invalid_input" }, 400);
      }
      const machine = machineStore.get(machineId);
      if (!machine?.baseUrl) return json({ error: "remote machine not found", code: "machine_not_found" }, 404);
      if (purpose === "catalog") {
        const projectId = stripCtrl(body?.projectId);
        const repositoryKey = projectId ? await repositoryKeyOf(projectId) : null;
        if (!projectId || !repositoryKey) return json({ error: "project repository unresolved", code: "repository_unresolved" }, 409);
        try {
          const opened = await nodeClient.openDelegatedRequest(machine.baseUrl, {
            purpose: "catalog", repositoryKey, originMachineId: machineStore.upsertLocal().id,
          });
          const now = Date.now();
          const id = crypto.randomUUID();
          ctx.db.query(`INSERT INTO delegated_node_requests
            (id,direction,purpose,remote_request_id,claim_secret,code,state,machine_id,base_url,repository_key,
             origin_device_id,expires_at,created_at,updated_at)
            VALUES (?,'origin','catalog',?,?,?,'pending',?,?,?,?,?,?,?)`).run(
            id, opened.requestId, opened.claim, opened.code, machineId, machine.baseUrl, repositoryKey,
            "catalog", now + opened.expiresInMs, now, now,
          );
          return json({ request: { id, purpose, code: opened.code, state: "pending", expiresAt: now + opened.expiresInMs } }, 201);
        } catch (err) {
          const answered = nodeFailure(err);
          if (answered) return answered;
          throw err;
        }
      }
      const capability = ctx.db.query(`SELECT * FROM agent_start_capabilities
        WHERE id=? AND machine_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`)
        .get(capabilityId, machineId, Date.now()) as Record<string, any> | null;
      if (!capability) return json({ error: "capability not found", code: "not_found" }, 404);
      const existing = ctx.db.query(`SELECT id FROM delegated_node_requests
        WHERE direction='origin' AND capability_id=? AND state IN ('pending','approved','active') ORDER BY created_at DESC LIMIT 1`)
        .get(capabilityId) as { id: string } | null;
      if (existing) return json({ error: "request already exists", code: "already_exists", requestId: existing.id }, 409);
      const localMachine = machineStore.upsertLocal();
      try {
        const opened = await nodeClient.openDelegatedRequest(machine.baseUrl, {
          purpose: "authorization",
          capabilityId: capabilityId!,
          subjectPersonId: capability.recipient_kind === "person" ? capability.recipient_id : null,
          subjectDeviceId: capability.recipient_kind === "device" ? capability.recipient_id : `cap-${capabilityId}`,
          machineId,
          repositoryKey: capability.repository_key,
          model: capability.model,
          effort: capability.effort,
          maxDurationMinutes: capability.max_duration_minutes,
          maxAttempts: 1,
          fanout: 1,
          originPersonId: capability.recipient_kind === "person" ? capability.recipient_id : null,
          originDeviceId: capability.recipient_kind === "device" ? capability.recipient_id : `cap-${capabilityId}`,
          originMachineId: localMachine.id,
        });
        const now = Date.now();
        const id = crypto.randomUUID();
        ctx.db.query(`INSERT INTO delegated_node_requests
          (id,direction,purpose,remote_request_id,claim_secret,code,state,machine_id,base_url,capability_id,repository_key,
           origin_person_id,origin_device_id,model,effort,max_duration_minutes,expires_at,created_at,updated_at)
          VALUES (?,'origin','authorization',?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, opened.requestId, opened.claim, opened.code, machineId, machine.baseUrl, capabilityId,
          capability.repository_key, capability.recipient_kind === "person" ? capability.recipient_id : null,
          capability.recipient_kind === "device" ? capability.recipient_id : `cap-${capabilityId}`,
          capability.model, capability.effort, capability.max_duration_minutes,
          now + opened.expiresInMs, now, now,
        );
        return json({ request: { id, code: opened.code, state: "pending", expiresAt: now + opened.expiresInMs } }, 201);
      } catch (err) {
        const answered = nodeFailure(err);
        if (answered) return answered;
        throw err;
      }
    }

    if (pathname === "/api/machines/delegated-requests" && method === "GET") {
      if (!installationOwner(req)) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const retries = ctx.db.query(`SELECT id,base_url,remote_request_id,claim_secret
        FROM delegated_node_requests WHERE direction='origin' AND revoke_pending=1`).all() as Array<Record<string, any>>;
      for (const retry of retries) {
        try {
          await nodeClient.revokeDelegatedRequest({
            baseUrl: retry.base_url, requestId: retry.remote_request_id, claim: retry.claim_secret,
          });
          ctx.db.query("UPDATE delegated_node_requests SET revoke_pending=0,last_error=NULL,updated_at=? WHERE id=?")
            .run(Date.now(), retry.id);
        } catch (err) {
          ctx.db.query("UPDATE delegated_node_requests SET last_error=?,updated_at=? WHERE id=?")
            .run(String(err), Date.now(), retry.id);
        }
      }
      const requests = ctx.db.query(`SELECT id,purpose,code,state,machine_id AS machineId,capability_id AS capabilityId,
        repository_key AS repositoryKey,expires_at AS expiresAt,revoke_pending AS revokePending,last_error AS lastError
        FROM delegated_node_requests WHERE direction='origin' ORDER BY created_at DESC`).all();
      return json({ requests });
    }

    const reissue = matchRoute(pathname, "/api/machines/delegated-requests/:id/reissue");
    if (reissue && method === "POST") {
      if (!installationOwner(req)) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const row = ctx.db.query("SELECT * FROM delegated_node_requests WHERE id=? AND direction='origin'").get(reissue.id) as Record<string, any> | null;
      if (!row) return json({ error: "request not found", code: "not_found" }, 404);
      const token = row.capability_id
        ? readDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, row.capability_id)
        : null;
      try {
        await nodeClient.revokeDelegatedRequest({
          baseUrl: row.base_url, requestId: row.remote_request_id, token: token ?? undefined,
          capabilityId: row.capability_id, claim: row.claim_secret,
        });
      } catch { /* New approval replaces the same capability atomically on the node. */ }
      if (row.capability_id) removeDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, row.capability_id);
      try {
        const opened = await nodeClient.openDelegatedRequest(row.base_url, row.purpose === "catalog" ? {
          purpose: "catalog",
          repositoryKey: row.repository_key,
          originMachineId: machineStore.upsertLocal().id,
        } : {
          purpose: "authorization",
          capabilityId: row.capability_id,
          subjectPersonId: row.origin_person_id,
          subjectDeviceId: row.origin_device_id,
          machineId: row.machine_id,
          repositoryKey: row.repository_key,
          model: row.model,
          effort: row.effort,
          maxDurationMinutes: row.max_duration_minutes,
          maxAttempts: 1,
          fanout: 1,
          originPersonId: row.origin_person_id,
          originDeviceId: row.origin_device_id,
          originMachineId: machineStore.upsertLocal().id,
        });
        const now = Date.now();
        ctx.db.query(`UPDATE delegated_node_requests SET remote_request_id=?,claim_secret=?,code=?,state='pending',
          authorization_id=NULL,expires_at=?,updated_at=?,revoke_pending=0,last_error=NULL WHERE id=?`).run(
          opened.requestId, opened.claim, opened.code, now + opened.expiresInMs, now, row.id,
        );
        return json({ request: { id: row.id, code: opened.code, state: "pending", expiresAt: now + opened.expiresInMs } });
      } catch (err) {
        const answered = nodeFailure(err);
        if (answered) return answered;
        throw err;
      }
    }

    const delegated = matchRoute(pathname, "/api/machines/delegated-requests/:id");
    if (delegated && (method === "GET" || method === "DELETE")) {
      if (!installationOwner(req)) return json({ error: "installation owner required", code: "owner_required" }, 403);
      const row = ctx.db.query("SELECT * FROM delegated_node_requests WHERE id=? AND direction='origin'").get(delegated.id) as Record<string, any> | null;
      if (!row) return json({ error: "request not found", code: "not_found" }, 404);
      if (method === "DELETE") {
        const token = row.capability_id
          ? readDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, row.capability_id)
          : null;
        const now = Date.now();
        ctx.db.transaction(() => {
          ctx.db.query("UPDATE agent_start_capabilities SET revoked_at=COALESCE(revoked_at,?),revoked_by_person_id=COALESCE(revoked_by_person_id,?) WHERE id=?")
            .run(now, installationOwner(req), row.capability_id);
          if (row.purpose === "catalog") {
            ctx.db.query(`UPDATE machine_delegated_model_catalogs SET revoked_at=COALESCE(revoked_at,?)
              WHERE machine_id=? AND repository_key=? AND authorization_id=?`).run(
              now, row.machine_id, row.repository_key, row.remote_request_id,
            );
          }
          ctx.db.query("UPDATE delegated_node_requests SET state='revoked',revoke_pending=1,updated_at=? WHERE id=?").run(now, row.id);
        })();
        try {
          await nodeClient.revokeDelegatedRequest({
            baseUrl: row.base_url, requestId: row.remote_request_id, token: token ?? undefined,
            capabilityId: row.capability_id, claim: row.claim_secret,
          });
          ctx.db.query("UPDATE delegated_node_requests SET revoke_pending=0,last_error=NULL,updated_at=? WHERE id=?").run(Date.now(), row.id);
          if (row.capability_id) removeDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, row.capability_id);
          return json({ ok: true, remoteRevoked: true });
        } catch (err) {
          ctx.db.query("UPDATE delegated_node_requests SET last_error=?,updated_at=? WHERE id=?").run(String(err), Date.now(), row.id);
          if (row.capability_id) removeDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, row.capability_id);
          return json({ ok: true, remoteRevoked: false, retryPending: true }, 202);
        }
      }
      if (row.state === "approved" && row.authorization_id) {
        try {
          await nodeClient.acknowledgeDelegatedRequest({ baseUrl: row.base_url, requestId: row.remote_request_id, claim: row.claim_secret });
          ctx.db.transaction(() => {
            ctx.db.query(`INSERT INTO machine_repository_authorizations
              (id,machine_id,repository_key,authorized_by_person_id,authorized_at)
              VALUES (?,?,?,?,?) ON CONFLICT(machine_id,repository_key) WHERE revoked_at IS NULL DO NOTHING`)
              .run(crypto.randomUUID(), row.machine_id, row.repository_key, installationOwner(req), Date.now());
            if (row.models_json) {
              ctx.db.query(`INSERT INTO machine_delegated_model_catalogs
                (machine_id,repository_key,authorization_id,models_json,verified_at,expires_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(machine_id,repository_key) DO UPDATE SET
                  authorization_id=excluded.authorization_id,models_json=excluded.models_json,
                  verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=NULL`).run(
                row.machine_id, row.repository_key, row.authorization_id, row.models_json, Date.now(), row.expires_at,
              );
            }
            ctx.db.query("UPDATE delegated_node_requests SET state='active',updated_at=? WHERE id=?").run(Date.now(), row.id);
          })();
          row.state = "active";
        } catch { /* Still safe: repository consent is absent, so dispatch remains closed. */ }
      } else if (row.state === "pending") {
        try {
          const outcome = await nodeClient.claimDelegatedRequest({ baseUrl: row.base_url, requestId: row.remote_request_id, claim: row.claim_secret });
          if (row.purpose === "catalog" && outcome.state === "approved" && outcome.models) {
            await nodeClient.acknowledgeDelegatedRequest({ baseUrl: row.base_url, requestId: row.remote_request_id, claim: row.claim_secret });
            ctx.db.transaction(() => {
              ctx.db.query(`INSERT INTO machine_delegated_model_catalogs
                (machine_id,repository_key,authorization_id,models_json,verified_at,expires_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(machine_id,repository_key) DO UPDATE SET
                  authorization_id=excluded.authorization_id,models_json=excluded.models_json,
                  verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=NULL`).run(
                row.machine_id, row.repository_key, row.remote_request_id, JSON.stringify(outcome.models),
                Date.now(), outcome.expiresAt ?? row.expires_at,
              );
              ctx.db.query("UPDATE delegated_node_requests SET state='active',expires_at=?,updated_at=? WHERE id=?")
                .run(outcome.expiresAt ?? row.expires_at, Date.now(), row.id);
            })();
            row.state = "active";
            row.expires_at = outcome.expiresAt ?? row.expires_at;
          } else if (outcome.state === "approved" && outcome.token && outcome.authorizationId) {
            writeDelegatedNodeToken(ctx.STATE_DIR, row.machine_id, row.capability_id, outcome.token);
            const expiresAt = outcome.expiresAt ?? row.expires_at;
            ctx.db.transaction(() => {
              ctx.db.query("UPDATE delegated_node_requests SET state='approved',authorization_id=?,models_json=?,expires_at=?,updated_at=? WHERE id=?")
                .run(outcome.authorizationId, JSON.stringify(outcome.models ?? []), expiresAt, Date.now(), row.id);
              ctx.db.query(`UPDATE agent_start_capabilities SET expires_at=CASE
                WHEN expires_at IS NULL OR expires_at>? THEN ? ELSE expires_at END WHERE id=?`)
                .run(expiresAt, expiresAt, row.capability_id);
            })();
            row.state = "approved";
          } else if (outcome.state !== "pending") {
            ctx.db.query("UPDATE delegated_node_requests SET state=?,updated_at=? WHERE id=?").run(outcome.state, Date.now(), row.id);
            row.state = outcome.state;
          }
        } catch (err) {
          return nodeFailure(err) ?? (() => { throw err; })();
        }
      }
      return json({ request: {
        id: row.id, purpose: row.purpose, capabilityId: row.capability_id, repositoryKey: row.repository_key,
        code: row.code, state: row.state, expiresAt: row.expires_at,
      } });
    }

    if (method === "GET" && pathname === "/api/machines") {
      return json({ machines: machineStore.list() });
    }

    if (method === "POST" && pathname === "/api/machines/pair") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");
      const baseUrl = normalizeNodeBaseUrl(body.baseUrl);
      if (!baseUrl) return errorResponse(400, "baseUrl must be an http(s) URL");
      sweepHandshakes();
      try {
        const opened = await nodeClient.pairRequest(baseUrl);
        const pairingId = crypto.randomUUID();
        pendingHandshakes.set(pairingId, {
          requestId: opened.requestId,
          claim: opened.claim,
          baseUrl,
          expiresAt: Date.now() + opened.expiresInMs,
        });
        return json({ pairingId, code: opened.code, expiresInMs: opened.expiresInMs });
      } catch (err) {
        const answered = nodeFailure(err);
        if (answered) return answered;
        throw err;
      }
    }

    {
      const params = matchRoute(pathname, "/api/machines/pair/:id");
      if (params && method === "GET") {
        sweepHandshakes();
        const pending = pendingHandshakes.get(params.id);
        if (!pending) return json({ state: "expired" });
        try {
          const outcome = await nodeClient.pairWait({
            baseUrl: pending.baseUrl,
            requestId: pending.requestId,
            claim: pending.claim,
            expiresInMs: Math.max(0, pending.expiresAt - Date.now()),
            maxPolls: 1,
          });
          if (outcome.state === "pending") return json({ state: "pending" });
          pendingHandshakes.delete(params.id);
          if (outcome.state !== "approved" || !outcome.token) return json({ state: outcome.state });
          // The hostname is the row's key (UNIQUE): the node's declared name
          // is what a person recognises, the URL host is the fallback for a
          // node that did not say. Never the token: it is written to disk and
          // nowhere else.
          const nodeHost = new URL(pending.baseUrl).host;
          const name = stripCtrl(outcome.name) || nodeHost;
          const machine = machineStore.upsertNode({ hostname: nodeHost, name, baseUrl: pending.baseUrl });
          writeNodeToken(ctx.STATE_DIR, machine.id, outcome.token);
          emit("machine:upserted", machine);
          return json({ state: "approved", machine });
        } catch (err) {
          const answered = nodeFailure(err);
          if (answered) return answered;
          throw err;
        }
      }
    }

    {
      const params = matchRoute(pathname, "/api/machines/:id");
      if (params) {
        if (method === "GET") {
          const m = machineStore.get(params.id);
          if (!m) return errorResponse(404, "Machine not found");
          return json(m);
        }
        if (method === "PATCH") {
          const body = await readJSON(req);
          if (!body) return errorResponse(400, "body required");
          const name = stripCtrl(body.name);
          if (!name) return errorResponse(400, "name required");
          if (name.length > NAME_MAX) return errorResponse(400, `name too long (max ${NAME_MAX})`);
          const m = machineStore.rename(params.id, name);
          if (!m) return errorResponse(404, "Machine not found");
          emit("machine:updated", m);
          return json(m);
        }
        if (method === "DELETE") {
          try {
            const ok = machineStore.delete(params.id);
            if (!ok) return errorResponse(404, "Machine not found");
            emit("machine:deleted", { id: params.id });
            return json({ ok: true });
          } catch (err: any) {
            if (err instanceof MachineInUseError) {
              return errorResponse(409, err.message);
            }
            throw err;
          }
        }
      }
    }
    return null;
  };
}
