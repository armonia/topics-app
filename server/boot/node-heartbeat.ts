import { SERVER_VERSION } from "../ws-capabilities";
import { hostname as osHostname } from "node:os";
import { createNodeClient, readNodeToken } from "../services/node-client";
import { createNodeProbe } from "../services/node-heartbeat";
import { CLOUD_NODE_BASE_URL, CLOUD_NODE_HOST, isCloudBaseUrl } from "../providers/claude-cloud/node";
import type { BootScope } from "../../server";

export function createNodeHeartbeat(d: {
  ctx: BootScope["ctx"];
  cloudNode: BootScope["cloudNode"];
  cloudEnabled: BootScope["cloudEnabled"];
}) {
  const { ctx, cloudNode, cloudEnabled } = d;

  // Phase D — heartbeat ticker. Upserts the local machine row every 30 s
  // and flips other machines that haven't checked in for 5 minutes to
  // `offline`. Cheap (one indexed UPDATE + one indexed SELECT per tick).
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const STALE_THRESHOLD_MS = 5 * 60_000;
  // A paired node (the PC) never calls us, so the ticker asks it (`node-heartbeat.ts`). The probe has
  // its own client: a short deadline, because a hung tunnel must not hold a round for ever.
  const probeNodes = createNodeProbe({
    list: () => ctx.machineStore.list(),
    client: createNodeClient({
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }),
      now: () => Date.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      version: SERVER_VERSION,
      hostname: osHostname(),
    }),
    tokenOf: (machineId) => readNodeToken(ctx.STATE_DIR, machineId),
    touch: (machineId) => ctx.machineStore.touchNode(machineId),
    onRefreshed: (machine) => ctx.broadcastToAll({ type: "machine:upserted", machine, payload_version: 1 }),
    isCloud: isCloudBaseUrl,
    log: (message, err) => console.warn(`[Heartbeat] ${message}`, err),
  });
  function tickHeartbeat() {
    try {
      const local = ctx.machineStore.upsertLocal();
      ctx.broadcastToAll({ type: "machine:upserted", machine: local, payload_version: 1 });
      // La macchina cloud non manda heartbeat: è viva finché c'è la sua riga, quindi la
      // rinfreschiamo noi, o dopo 5 minuti la card direbbe «non risponde» su un servizio vivo.
      // Solo se il cloud è acceso QUI: una riga rimasta da un avvio di prima, a cloud spento,
      // deve diventare «non risponde» col giro normale invece di restare in linea.
      // And only while the account has an active cloud environment: without one the node
      // answers but can start nothing (30/10: the Keychain login moved to an account with no
      // environments), and "online" sent cards there. Asked from here, at most every 5 minutes.
      const cloud = cloudEnabled ? ctx.machineStore.getByHostname(CLOUD_NODE_HOST) : null;
      if (cloud && isCloudBaseUrl(cloud.baseUrl)) {
        void cloudNode.probeEnvironment();
        const env = cloudNode.environmentReady();
        if (env && !env.ok) {
          const off = ctx.machineStore.markNodeOffline(cloud.id);
          if (off) {
            console.warn(`[claude-cloud] offline: ${env.reason}`);
            ctx.broadcastToAll({ type: "machine:updated", machine: off, payload_version: 1 });
          }
        } else {
          ctx.machineStore.upsertNode({ hostname: CLOUD_NODE_HOST, name: cloud.name, baseUrl: CLOUD_NODE_BASE_URL });
        }
      }
      probeNodes();
      const flipped = ctx.machineStore.markStaleOffline(STALE_THRESHOLD_MS);
      for (const m of flipped) {
        ctx.broadcastToAll({ type: "machine:updated", machine: m, payload_version: 1 });
      }
    } catch (err) {
      console.warn("[Heartbeat] tick failed:", err);
    }
  }
  tickHeartbeat();
  const heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_INTERVAL_MS);

  return { heartbeatTimer };
}
