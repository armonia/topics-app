/**
 * The machines' health round: every 5 minutes it samples CPU and memory of
 * every machine Topics uses, every 30 minutes it asks for their security
 * probes, and it writes `<APP_DATA_DIR>/machines-health.json` for the tray.
 *
 * The machines come from the `machines` table: this computer and the paired
 * nodes (the fixed server, the PC). A node is asked the way the load view
 * already does: the row's address and the device token. The probe runs ON the
 * node (same Topics code); if the node does not answer, or is a version that
 * does not know the probe, its last result stays, with its own time.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../types";
import type { MachineMetrics } from "../../shared/machine-overview";
import type { MachineSecurityReport } from "../../shared/machine-health";
import { createMachineHealth, STEP_S, type HealthTarget } from "../lib/machine-health";
import { applyExposure, poolIpOf } from "../lib/machine-exposure";
import { readLocalMetrics } from "../lib/machine-metrics";
import { localSecurityProbe } from "../routes/machine-security";
import { NODE_SESSION_COOKIE, readNodeToken } from "../services/node-client";
import { isCloudBaseUrl } from "../providers/claude-cloud/node";

/** How long to wait for a node's probe: its commands have 5 s each, in parallel, and the macOS log needs longer. */
const REMOTE_PROBE_TIMEOUT_MS = 30_000;
const REMOTE_METRICS_TIMEOUT_MS = 5_000;
/** The first round waits a little: server startup must not pay for system commands. */
const FIRST_TICK_DELAY_MS = 20_000;

export const MACHINES_HEALTH_FILE = "machines-health.json";

async function fetchNodeJson<T>(ctx: AppContext, id: string, baseUrl: string, path: string, timeoutMs: number): Promise<T | null> {
  const token = readNodeToken(ctx.STATE_DIR, id);
  if (!token) return null;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: "application/json", Cookie: `${NODE_SESSION_COOKIE}=${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The public IP of a cloud node from `node-pool/state.json`; `null` for a machine with no public address (the PC, this computer). */
async function publicHostOf(ctx: AppContext, machineId: string): Promise<string | null> {
  try { return poolIpOf(await readFile(join(ctx.APP_DATA_DIR, "node-pool", "state.json"), "utf8"), machineId); } catch { return null; }
}

export function startMachineHealth(ctx: AppContext): void {
  const probeLocal = localSecurityProbe(ctx.APP_DATA_DIR);

  const targetsNow = (): Array<HealthTarget & { baseUrl: string | null }> => {
    const local = ctx.machineStore.upsertLocal();
    const nodes = ctx.machineStore.list().filter((m) => m.id !== local.id && !!m.baseUrl && !isCloudBaseUrl(m.baseUrl));
    return [
      { id: local.id, name: local.name, kind: "local", baseUrl: null },
      ...nodes.map((m) => ({ id: m.id, name: m.name, kind: "remote" as const, baseUrl: m.baseUrl })),
    ];
  };
  const baseUrlOf = new Map<string, string | null>();

  const health = createMachineHealth({
    targets: () => {
      const all = targetsNow();
      baseUrlOf.clear();
      for (const t of all) baseUrlOf.set(t.id, t.baseUrl);
      return all.map(({ id, name, kind }) => ({ id, name, kind }));
    },
    readMetrics: async (t) => {
      const metrics: MachineMetrics | null = t.kind === "local"
        ? readLocalMetrics()
        : (await fetchNodeJson<{ metrics?: MachineMetrics }>(ctx, t.id, baseUrlOf.get(t.id) ?? "", "/api/system/machine-metrics", REMOTE_METRICS_TIMEOUT_MS))?.metrics ?? null;
      return metrics ? { cpu: metrics.cpuPct, mem: metrics.memPct } : null;
    },
    probe: async (t): Promise<MachineSecurityReport | null> => {
      if (t.kind === "local") return probeLocal();
      const report = await fetchNodeJson<MachineSecurityReport>(ctx, t.id, baseUrlOf.get(t.id) ?? "", "/api/system/machine-security", REMOTE_PROBE_TIMEOUT_MS);
      // The node is reached through a tunnel; its public address (if it has one) is in the node pool's register.
      return report ? applyExposure(report, await publicHostOf(ctx, t.id)).catch(() => report) : null;
    },
    attemptsToday: (sinceMs) => (ctx.db.query(
      `SELECT t.machine_id AS machineId, a.created_at AS createdAt
         FROM task_attempts a JOIN tasks t ON t.id = a.task_id
        WHERE a.created_at >= ?`,
    ).all(new Date(sinceMs).toISOString()) as Array<{ machineId: string | null; createdAt: string }>),
    attribute: (machineId) => {
      const local = ctx.machineStore.upsertLocal();
      if (machineId === null || machineId === local.id) return local.id;
      const row = ctx.machineStore.get(machineId);
      if (!row) return null;
      if (isCloudBaseUrl(row.baseUrl)) return null;
      // A row without an address is an old name of this same computer (the network host name changes with the network).
      return row.baseUrl ? row.id : local.id;
    },
    filePath: join(ctx.APP_DATA_DIR, MACHINES_HEALTH_FILE),
    statePath: join(ctx.APP_DATA_DIR, "machines-health-history.json"),
    now: Date.now,
    log: (msg) => console.warn(msg),
  });

  setTimeout(() => {
    void health.tick();
    setInterval(() => void health.tick(), STEP_S * 1000).unref?.();
  }, FIRST_TICK_DELAY_MS).unref?.();
}
