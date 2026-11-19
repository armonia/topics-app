/**
 * The NODE scope: what the credential a server collects by pairing this one as
 * its node may reach.
 *
 * Before it, that credential was an owner's (card a97724c1). Through the tunnel
 * it could create a topic and run a command on the node, and a command running
 * on the node is on loopback, which is the one transport `pair/approve` trusts
 * to hand the node's channel over. So a paired server could take the channel
 * the guard on `pair/approve` exists to protect, by asking the node to `curl`
 * itself.
 *
 * The list below is every call a primary makes on a node with that cookie, read
 * from the code that makes them:
 *
 *  - `services/node-client.ts`: `createRun` (POST /api/nodes/runs), `readRun`
 *    (GET /api/nodes/runs/:id, also the heartbeat probe of
 *    `services/node-heartbeat.ts`), `cancelRun` (DELETE /api/nodes/runs/:id),
 *    `fetchBundle` (GET /api/nodes/runs/:id/bundle), `codingModels`
 *    (GET /api/providers/snapshot). The delegated-runs and delegated-requests
 *    calls ride on a delegated credential or on no identity at all
 *    (`isIdentityExemptPath`), never on this cookie; pair/request and
 *    pair/status are identity exempt too.
 *  - `boot/machine-health.ts`: GET /api/system/machine-metrics and
 *    GET /api/system/machine-security.
 *  - `routes/machine-readout.ts`: GET /api/system/machine-readout.
 *  - `routes/machines-overview.ts`: GET /api/system/machine-metrics.
 *
 * The model proxy and the tunnel are not here on purpose: the proxy is the
 * node calling its primary with a model token, and the tunnel is a transport,
 * not a route. An allowlist, as for a screen (`lib/screen-scope.ts`): a new
 * route is shut to a node credential until somebody names it here.
 */
import type { Database } from "bun:sqlite";

type Db = Pick<Database, "query">;

const EXACT = new Set([
  "POST /api/nodes/runs",
  "GET /api/providers/snapshot",
  "GET /api/system/machine-metrics",
  "GET /api/system/machine-security",
  "GET /api/system/machine-readout",
]);
const RUN = /^\/api\/nodes\/runs\/[^/]+$/;
const RUN_BUNDLE = /^\/api\/nodes\/runs\/[^/]+\/bundle$/;

export function isNodeAllowedRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  if (EXACT.has(`${m} ${pathname}`)) return true;
  if (RUN.test(pathname)) return m === "GET" || m === "DELETE";
  return m === "GET" && RUN_BUNDLE.test(pathname);
}

/**
 * The user agent every Topics server sends to its nodes (`createNodeClient`):
 * `Topics/<version> (<hostname>)`. A browser or a phone never sends it.
 */
const SERVER_AGENT = /^Topics\/\S+ \(([^)]*)\)/;

export function isTopicsServerAgent(ua: string | null): boolean {
  return ua !== null && SERVER_AGENT.test(ua);
}

/** The hostname a Topics server names in its user agent; `null` for anything else. */
export function serverAgentHost(ua: string | null): string | null {
  const host = ua ? SERVER_AGENT.exec(ua)?.[1]?.trim() : "";
  return host ? host.slice(0, 60) : null;
}

/** Paired as a node credential? A missing table (schema older than the migration) is "no". */
export function isNodeDevice(db: Db, deviceId: string): boolean {
  try {
    return db.query("SELECT 1 AS one FROM node_devices WHERE device_id = ?").get(deviceId) !== null;
  } catch {
    return false;
  }
}

export function markNodeDevice(db: Db, deviceId: string, machineId: string | null, now = Date.now()): void {
  db.query("INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at) VALUES (?, ?, ?)").run(deviceId, machineId, now);
}

/**
 * The second half of the migration. A machine credential paired before the
 * node scope existed left no trace saying it was one, unless it holds the
 * channel (which the SQL migration reads). It shows itself the first time it
 * does what only a primary does: a Topics server calling the node's run
 * routes. Marking it narrows what it can do and nothing else, and everything
 * it was doing stays inside the allowlist, so the fleet keeps working.
 */
export function shouldLearnNodeDevice(pathname: string, ua: string | null): boolean {
  return pathname.startsWith("/api/nodes/runs") && isTopicsServerAgent(ua);
}

/**
 * May this node credential create runs here, and read the ones nobody signed?
 * The device that holds this node's channel; with no channel yet, the machine
 * the migration found driving this node (`legacy_driver`), else the one node
 * credential paired. Any other paired server (a secondary, a stale cookie)
 * reaches the run routes and finds nothing it may touch: a run is a card born
 * in `bypassPermissions`, which is command execution under another name.
 */
export function mayDriveRuns(db: Db, deviceId: string): boolean {
  try {
    const channel = db.query("SELECT channel_device_id AS id FROM primary_state WHERE id = 1").get() as { id: string | null } | null;
    if (channel?.id) return channel.id === deviceId;
    const rows = db.query(`SELECT n.device_id AS id, n.legacy_driver AS driver FROM node_devices n
        JOIN devices d ON d.id = n.device_id WHERE d.revoked_at IS NULL`).all() as { id: string; driver: number }[];
    const driver = rows.find((r) => r.driver === 1);
    if (driver) return driver.id === deviceId;
    return rows.length === 1 && rows[0].id === deviceId;
  } catch {
    return false;
  }
}

/** Signs a run with the node credential that asked for it (`tasks.node_run_device`). */
export function signNodeRun(db: Db, taskId: string, deviceId: string): void {
  db.query("UPDATE tasks SET node_run_device = ? WHERE id = ?").run(deviceId, taskId);
}

/**
 * A run a node credential may read, fetch or cancel: one of the node's run
 * mirrors (`node-run:` key) it asked for itself, or an unsigned one (started
 * before runs were signed) when it is the device that drives runs here. A
 * normal card of the board is never one.
 */
export function ownsNodeRun(db: Db, deviceId: string, taskId: string): boolean {
  const row = db.query("SELECT claude_task_id AS key, node_run_device AS device FROM tasks WHERE id = ?").get(taskId) as
    { key: string | null; device: string | null } | null;
  if (!row?.key?.startsWith("node-run:")) return false;
  if (row.device) return row.device === deviceId;
  return mayDriveRuns(db, deviceId);
}
