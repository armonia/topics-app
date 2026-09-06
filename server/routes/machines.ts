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
  createNodeClient, isNodeError, normalizeNodeBaseUrl, writeNodeToken,
  type NodeClient, type NodeFailureReason,
} from "../services/node-client";
import { SERVER_VERSION } from "../ws-capabilities";

const NAME_MAX = 200;

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
  const sweepHandshakes = () => {
    const now = Date.now();
    for (const [id, p] of pendingHandshakes) if (p.expiresAt <= now) pendingHandshakes.delete(id);
  };

  const nodeFailure = (err: unknown): Response | null => {
    if (!isNodeError(err)) return null;
    return json({ error: err.message, code: err.reason }, UPSTREAM_STATUS[err.reason]);
  };

  return async function machinesRouter(req, _url, pathname, method) {
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
