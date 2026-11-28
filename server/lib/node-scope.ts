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
 *    (GET /api/providers/snapshot), `readVersion` (GET /api/version, the heartbeat's read of the node's real version). The delegated-runs and delegated-requests
 *    calls ride on a delegated credential or on no identity at all
 *    (`isIdentityExemptPath`), never on this cookie; pair/request and
 *    pair/status are identity exempt too.
 *  - `boot/machine-health.ts`: GET /api/system/machine-metrics and
 *    GET /api/system/machine-security.
 *  - `routes/machine-readout.ts`: GET /api/system/machine-readout.
 *  - `routes/machines-overview.ts`: GET /api/system/machine-metrics.
 *  - `services/node-client.ts` again, for the worktrees of the node (`routes/nodes-worktrees.ts`):
 *    `worktreeSummary` (GET /api/nodes/worktrees), `putWorktreePolicy`
 *    (PUT /api/nodes/worktree-policy), `worktreeGc` (POST /api/nodes/worktrees/gc).
 *  - `services/node-client.ts` again, when the primary hands itself over (`routes/nodes-primary.ts`):
 *    `primaryUpload` (PUT /api/nodes/primary/incoming), `primaryCommit` (POST /api/nodes/primary/commit).
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
  "GET /api/version",
  "GET /api/system/machine-metrics",
  "GET /api/system/machine-security",
  "GET /api/system/machine-readout",
  "GET /api/nodes/worktrees",
  "PUT /api/nodes/worktree-policy",
  "POST /api/nodes/worktrees/gc",
  "PUT /api/nodes/primary/incoming",
  "POST /api/nodes/primary/commit",
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

/**
 * How a device came to be a node credential: `paired` by a pairing this server
 * approved after the node scope existed, `migrated` by the migration (a machine
 * credential paired before it), `learned` by the gate (an owner credential that
 * called the run routes as a Topics server, which can only narrow it). The last
 * two predate the channel, which is why they may still drive runs on a node
 * that has none.
 */
export type NodeDeviceOrigin = "paired" | "migrated" | "learned";

export function markNodeDevice(db: Db, deviceId: string, machineId: string | null, origin: NodeDeviceOrigin, now = Date.now()): void {
  db.query("INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at, origin) VALUES (?, ?, ?, ?)").run(deviceId, machineId, now, origin);
}

/**
 * Every credential this node still holds as an owner's that never showed a
 * person's hand (no push subscription, no message it wrote, not a screen) becomes
 * a node credential. The name the device carries is not read: it is the user
 * agent in disguise, and a person's `curl` or a server called like a platform
 * both fooled the name. It fails toward the narrower role: a person wrongly
 * narrowed pairs again with six characters, a machine wrongly left an owner
 * would run commands. Returns the devices it narrowed, for the server log.
 */
export function restrictMachineLikeDevices(db: Database, now = Date.now()): Array<{ id: string; name: string }> {
  const rows = db.query(
    `SELECT d.id, d.name FROM devices d
      WHERE d.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM node_devices n WHERE n.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM screen_devices s WHERE s.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.auth_device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_device_id = d.id)`,
  ).all() as Array<{ id: string; name: string }>;
  for (const row of rows) markNodeDevice(db, row.id, null, "migrated", now);
  return rows;
}

/**
 * May this node credential create, read and cancel runs here? Being a node is
 * not enough: every server that pairs this one gets a node credential, and a
 * run is a card that starts in `bypassPermissions`, so a run from anyone but
 * the primary is execution again. With a channel, only its device. Without one
 * (a node paired before the channel was recorded), the credentials that predate
 * the node scope, or the one machine credential when it is the only one.
 */
export function mayDriveNodeRuns(db: Db, deviceId: string): boolean {
  const channel = db.query("SELECT channel_device_id FROM primary_state WHERE id = 1").get() as { channel_device_id: string | null } | null;
  if (channel?.channel_device_id) return channel.channel_device_id === deviceId;
  const live = db.query(`SELECT n.device_id, n.origin FROM node_devices n JOIN devices d ON d.id = n.device_id
      WHERE d.revoked_at IS NULL`).all() as { device_id: string; origin: string }[];
  const own = live.find((n) => n.device_id === deviceId);
  if (!own) return false;
  return own.origin !== "paired" || live.length === 1;
}

/** Remember which credential created a run, so only it reads, bundles and cancels it. */
export function recordNodeRunCaller(db: Db, taskId: string, deviceId: string, now = Date.now()): void {
  const machine = db.query("SELECT machine_id FROM node_devices WHERE device_id = ?").get(deviceId) as { machine_id: string | null } | null;
  db.query("INSERT OR REPLACE INTO node_run_callers (task_id, device_id, machine_id, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, deviceId, machine?.machine_id ?? null, now);
}

/**
 * Is this task a run the caller may touch? Only a mirror (`node-run:`), never a
 * card of this board, and only one this caller created: the same device, or the
 * same machine paired again under a new device. A run created before callers
 * were recorded belongs to whoever may drive runs at all.
 */
export function ownsNodeRun(db: Db, taskId: string, deviceId: string, runKeyPrefix: string): boolean {
  const task = db.query("SELECT claude_task_id FROM tasks WHERE id = ?").get(taskId) as { claude_task_id: string | null } | null;
  if (!task?.claude_task_id?.startsWith(runKeyPrefix)) return false;
  const caller = db.query("SELECT device_id, machine_id FROM node_run_callers WHERE task_id = ?").get(taskId) as
    { device_id: string; machine_id: string | null } | null;
  if (!caller || caller.device_id === deviceId) return true;
  const mine = db.query("SELECT machine_id FROM node_devices WHERE device_id = ?").get(deviceId) as { machine_id: string | null } | null;
  return caller.machine_id !== null && mine?.machine_id === caller.machine_id;
}

/**
 * The runtime half of the migration, and it can only narrow. The migration
 * marks every machine credential the database can tell apart (`origin =
 * 'migrated'`); one it missed, an owner credential a person renamed, shows
 * itself the first time a Topics server calls the run routes with it, and is
 * marked then. A credential without that user agent is never kept owner by it:
 * the user agent decides nothing but a downgrade.
 */
export function shouldLearnNodeDevice(pathname: string, ua: string | null): boolean {
  return pathname.startsWith("/api/nodes/runs") && isTopicsServerAgent(ua);
}
