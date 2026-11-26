/**
 * Routes: this machine RECEIVES the primary (track T4 of
 * `openspec/changes/nodo-principale-a-mano`). They run on the node, called by
 * the primary that is handing itself over.
 *
 *   PUT  /api/nodes/primary/incoming?name=<bundle name>&offset=<n>   one chunk of one file
 *   POST /api/nodes/primary/commit                                  the manifest: verify, then restart
 *
 * Nothing is swapped here: the files are staged under the state dir, the commit
 * checks every hash, the DB integrity and the row counts, writes the manifest
 * and restarts this server; the boot puts the DB in place before opening it.
 *
 * WHO: only the device of the primary holding this node's channel. The bundle
 * replaces this machine's whole DB, so not the owner from a browser, not
 * another paired server, not a delegated credential. No channel, no switch.
 */
import { hostname } from "node:os";
import type { AppContext, RouteHandler } from "../types";
import { getPrimaryRole, guardNodesCall } from "../lib/primary-role";
import { commitIncoming, discardIncoming, isSafeBundleName, writeIncomingChunk, type SwitchManifest } from "../lib/primary-switch";

export const NODE_PRIMARY_INCOMING_PATH = "/api/nodes/primary/incoming";
export const NODE_PRIMARY_COMMIT_PATH = "/api/nodes/primary/commit";

export interface NodePrimaryDeps {
  stateDir: string;
  hostname?: () => string;
  /** Restarts this server once the commit answer is on its way. */
  restart: () => void;
}

type RequestIdentity = ReturnType<NonNullable<AppContext["requestIdentity"]>>;

export function authorizePrimaryReceive(identity: RequestIdentity): { error: string; code: string } | null {
  if (identity?.delegatedAuthorizationId) return { error: "a delegated credential cannot move the primary", code: "delegated_scope" };
  const channel = getPrimaryRole()?.channel() ?? null;
  if (!channel) return { error: "this machine has no primary channel: nobody may hand it the primary", code: "no_channel" };
  if (!identity?.deviceId || identity.deviceId !== channel.deviceId) {
    return { error: "only the primary holding this node's channel may hand it the primary", code: "not_channel" };
  }
  return null;
}

export function createNodePrimaryRouter(ctx: AppContext, deps: NodePrimaryDeps): RouteHandler {
  const { json, readJSON } = ctx;
  const host = deps.hostname ?? hostname;

  return async function nodePrimaryRouter(req, url, pathname, method) {
    if (pathname !== NODE_PRIMARY_INCOMING_PATH && pathname !== NODE_PRIMARY_COMMIT_PATH) return null;
    const identity = ctx.requestIdentity?.(req) ?? null;
    const denied = authorizePrimaryReceive(identity);
    if (denied) return json(denied, 403);
    const stale = guardNodesCall(req, identity);
    if (stale) return stale;

    if (pathname === NODE_PRIMARY_INCOMING_PATH) {
      if (method !== "PUT") return json({ error: "method not allowed" }, 405);
      const name = url.searchParams.get("name") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? "");
      if (!isSafeBundleName(name)) return json({ error: "refused bundle name", code: "invalid_input" }, 400);
      if (!Number.isInteger(offset) || offset < 0) return json({ error: "offset must be a whole number", code: "invalid_input" }, 400);
      try {
        const size = writeIncomingChunk(deps.stateDir, name, offset, new Uint8Array(await req.arrayBuffer()));
        return json({ ok: true, size });
      } catch (err) {
        // A chunk out of order means the sender gave up or started over: nothing staged is kept.
        discardIncoming(deps.stateDir);
        return json({ error: err instanceof Error ? err.message : String(err), code: "invalid_chunk" }, 400);
      }
    }

    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    const manifest = await readJSON(req) as SwitchManifest;
    const verdict = await commitIncoming(deps.stateDir, manifest, { hostname: host(), epoch: getPrimaryRole()?.epoch() ?? 0 });
    if (!verdict.ok) {
      // A refused bundle is never committed later: its secrets leave the disk now.
      discardIncoming(deps.stateDir);
      return json({ error: verdict.error, code: verdict.code }, 409);
    }
    console.warn(`[primary] committed the primary at epoch ${manifest.epoch} from ${manifest.fromMachineId}: restarting to restore it`);
    deps.restart();
    return json({ ok: true, counts: verdict.counts });
  };
}
