/**
 * The machines' health round: every 5 minutes it samples CPU and memory of
 * every machine Topics uses, every 30 minutes it asks for their security
 * probes, and it writes `~/.topics/machines-health.json` for the tray.
 *
 * The machines come from the `machines` table: this computer and the paired
 * nodes (the fixed server, the PC). A node is asked the way the load view
 * already does: the row's address and the device token. The probe runs ON the
 * node (same Topics code); if the node does not answer, or is a version that
 * does not know the probe, its last result stays, with its own time.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import type { MachineMetrics } from "../../shared/machine-overview";
import type { MachineSecurityReport } from "../../shared/machine-health";
import { cardRunsToday, createMachineHealth, samplesFromMinuteLog, STEP_S, type HealthTarget } from "../lib/machine-health";
import { applyExposure, poolIpOf } from "../lib/machine-exposure";
import { memPctFromReadout, readLocalMetrics } from "../lib/machine-metrics";
import { probeSshServer, readSshServers, resolveSshControlDir, sshServerId, type SshServer } from "../lib/machine-security-ssh";
import { probeUnavailableReport } from "../lib/machine-security";
import { runBounded } from "../lib/machine-security-env";
import { localSecurityProbe } from "../routes/machine-security";
import { NODE_SESSION_COOKIE, readNodeToken } from "../services/node-client";
import { isCloudBaseUrl } from "../providers/claude-cloud/node";
import { createTaskService } from "../services/tasks";
import { getAppSettings } from "../services/app-settings";
import { createSecurityAlertsRound } from "./machine-security-alerts";
import { AUDIT_POLL_MS, createDependencyAuditRound, fetchLatestAuditRun, resolveAuditSource } from "./dependency-audit-alert";

/** How long to wait for a node's probe: its commands have 5 s each, in parallel, and the macOS log needs longer. */
const REMOTE_PROBE_TIMEOUT_MS = 30_000;
const REMOTE_METRICS_TIMEOUT_MS = 5_000;
/** The first round waits a little: server startup must not pay for system commands. */
const FIRST_TICK_DELAY_MS = 20_000;

export const MACHINES_HEALTH_FILE = "machines-health.json";

/**
 * Where the tray and the node tooling (`node-pool`, `harness-sync`) keep their
 * files: `~/.topics`, whatever data folder this server uses. The production
 * server on the Mac runs on a legacy data folder, so writing next to the
 * database would put the file where the tray never looks.
 */
export function sharedToolingDir(): string {
  return process.env.TOPICS_TOOLING_DIR || join(homedir(), ".topics");
}

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
async function publicHostOf(machineId: string): Promise<string | null> {
  try { return poolIpOf(await readFile(join(sharedToolingDir(), "node-pool", "state.json"), "utf8"), machineId); } catch { return null; }
}

/**
 * Whether a paired node is the home PC: a node with no seat in the cloud pool (`node-pool/state.json` lists
 * the paid servers by machine id). Only that one has a minute log from the usage hub.
 */
async function isHomePc(machineId: string): Promise<boolean> {
  try {
    const slots = (JSON.parse(await readFile(join(sharedToolingDir(), "node-pool", "state.json"), "utf8")) as { slots?: Record<string, { machine_id?: string }> }).slots ?? {};
    return !Object.values(slots).some((slot) => slot.machine_id === machineId);
  } catch { return true; }
}

/** The node's security report; a 404 means its build predates the route, which is an answer worth recording. */
async function fetchNodeProbe(ctx: AppContext, id: string, baseUrl: string): Promise<MachineSecurityReport | null> {
  const token = readNodeToken(ctx.STATE_DIR, id);
  if (!token) return null;
  try {
    const res = await fetch(`${baseUrl}/api/system/machine-security`, {
      headers: { Accept: "application/json", Cookie: `${NODE_SESSION_COOKIE}=${token}` },
      signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) return probeUnavailableReport(Date.now());
    return res.ok ? ((await res.json()) as MachineSecurityReport) : null;
  } catch {
    return null;
  }
}

export function startMachineHealth(ctx: AppContext): void {
  const probeLocal = localSecurityProbe(ctx.APP_DATA_DIR);
  const securityAlerts = createSecurityAlertsRound({
    db: ctx.db,
    svc: createTaskService(ctx.db, {}),
    broadcast: (event) => ctx.broadcastToAll(event as Parameters<typeof ctx.broadcastToAll>[0]),
    projectId: () => getAppSettings().securityAlertsProjectId,
    statePath: join(sharedToolingDir(), "machines-security-alerts.json"),
    now: Date.now,
  });

  // Servers without Topics, from the servers file; read on every round so an edit needs no restart.
  const sshServers = new Map<string, SshServer>();
  const lastSsh = new Map<string, MachineSecurityReport>();

  const targetsNow = (): Array<HealthTarget & { baseUrl: string | null }> => {
    const local = ctx.machineStore.upsertLocal();
    const nodes = ctx.machineStore.list().filter((m) => m.id !== local.id && !!m.baseUrl && !isCloudBaseUrl(m.baseUrl));
    return [
      { id: local.id, name: local.name, kind: "local", baseUrl: null },
      ...nodes.map((m) => ({ id: m.id, name: m.name, kind: "remote" as const, baseUrl: m.baseUrl })),
      ...[...sshServers].map(([id, s]) => ({ id, name: s.host, kind: "remote" as const, baseUrl: null })),
    ];
  };
  const baseUrlOf = new Map<string, string | null>();

  const health = createMachineHealth({
    targets: () => {
      sshServers.clear();
      for (const s of readSshServers(ctx.APP_DATA_DIR)) sshServers.set(sshServerId(s), s);
      const all = targetsNow();
      baseUrlOf.clear();
      for (const t of all) baseUrlOf.set(t.id, t.baseUrl);
      return all.map(({ id, name, kind }) => ({ id, name, kind }));
    },
    readMetrics: async (t) => {
      if (sshServers.has(t.id)) return null;
      if (t.kind === "local") {
        const local = readLocalMetrics();
        return { cpu: local.cpuPct, mem: local.memPct };
      }
      const baseUrl = baseUrlOf.get(t.id) ?? "";
      const metrics: MachineMetrics | null = (await fetchNodeJson<{ metrics?: MachineMetrics }>(ctx, t.id, baseUrl, "/api/system/machine-metrics", REMOTE_METRICS_TIMEOUT_MS))?.metrics ?? null;
      if (!metrics) return null;
      if (metrics.memPct !== null) return { cpu: metrics.cpuPct, mem: metrics.memPct };
      // A node still running a build that cannot read its own memory (a Linux server before the /proc/meminfo reading):
      // its process list is old enough to exist, so the processes' memory over the machine total stands in.
      const readout = await fetchNodeJson<{ memTotalMB?: number | null; procs?: Array<{ memMB: number }>; rest?: { memMB: number } }>(ctx, t.id, baseUrl, "/api/system/machine-readout", REMOTE_METRICS_TIMEOUT_MS);
      return { cpu: metrics.cpuPct, mem: memPctFromReadout(readout) };
    },
    externalSamples: async (t, sinceS) => {
      // An ssh-only server is not in the node pool either, but it is not the PC: without this it showed the PC's history.
      if (t.kind === "local" || sshServers.has(t.id) || !(await isHomePc(t.id))) return [];
      try { return samplesFromMinuteLog(await readFile(join(sharedToolingDir(), "usage-history", "pc-history.jsonl"), "utf8"), sinceS); } catch { return []; }
    },
    probe: async (t): Promise<MachineSecurityReport | null> => {
      if (t.kind === "local") return probeLocal();
      const ssh = sshServers.get(t.id);
      if (ssh) {
        const controlDir = resolveSshControlDir(ctx.APP_DATA_DIR);
        const report = await probeSshServer(ssh, runBounded, controlDir, lastSsh.get(t.id) ?? null, Date.now);
        lastSsh.set(t.id, report);
        return report;
      }
      const report = await fetchNodeProbe(ctx, t.id, baseUrlOf.get(t.id) ?? "");
      // The node is reached through a tunnel; its public address (if it has one) is in the node pool's register.
      return report ? applyExposure(report, await publicHostOf(t.id)).catch(() => report) : null;
    },
    attemptsToday: (sinceMs) => cardRunsToday(ctx.db, sinceMs),
    attribute: (machineId) => {
      const local = ctx.machineStore.upsertLocal();
      if (machineId === null || machineId === local.id) return local.id;
      const row = ctx.machineStore.get(machineId);
      if (!row) return null;
      if (isCloudBaseUrl(row.baseUrl)) return null;
      // A row without an address is an old name of this same computer (the network host name changes with the network).
      return row.baseUrl ? row.id : local.id;
    },
    onRound: securityAlerts,
    filePath: join(sharedToolingDir(), MACHINES_HEALTH_FILE),
    statePath: join(sharedToolingDir(), "machines-health-history.json"),
    now: Date.now,
    log: (msg) => console.warn(msg),
  });

  const auditRound = createDependencyAuditRound({
    db: ctx.db,
    svc: createTaskService(ctx.db, {}),
    broadcast: (event) => ctx.broadcastToAll(event as Parameters<typeof ctx.broadcastToAll>[0]),
    projectId: () => getAppSettings().securityAlertsProjectId,
    latestRun: async (projectId) => {
      const row = ctx.db.query("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | null;
      const source = await resolveAuditSource(row?.path ?? null);
      return source ? fetchLatestAuditRun(source) : null;
    },
  });

  setTimeout(() => {
    void auditRound().catch((err) => console.warn("[dependency-audit]", err));
    setInterval(() => void auditRound().catch((err) => console.warn("[dependency-audit]", err)), AUDIT_POLL_MS).unref?.();
    void health.tick();
    setInterval(() => void health.tick(), STEP_S * 1000).unref?.();
  }, FIRST_TICK_DELAY_MS).unref?.();
}
