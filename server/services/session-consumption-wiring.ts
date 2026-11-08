/**
 * The live wiring of the per-session consumption (`session-consumption.ts`):
 * where each of its sources comes from in the running server. Kept apart so
 * the service itself imports none of the heavy modules (terminals, processes,
 * the task service) and a unit test drives it with plain functions.
 */
import type { AppContext } from "../types";
import { listSessionCliPids } from "../providers/session-pids";
import { readNativeUsage } from "../providers/native-usage-registry";
import { listNativeCommands } from "../lib/native-command-registry";
import { fleetCpuCores, getFleetUsage, lastFleetTable, resolveFleetRoots, responsiblePid } from "../lib/fleet-usage";
import { listTerminalOwners } from "../routes/terminal";
import { listSessionOwnedProcesses, listUnownedScriptPids } from "../routes/processes";
import { createTaskService } from "./tasks";
import { projectIdForPath } from "../../shared/board";
import { projectLabel } from "../../shared/project-label";
import { createSessionConsumption, type ConsumptionDeps, type SessionConsumptionService, type UsageReading } from "./session-consumption";
import type { SessionUsage } from "./transcript-usage";

/** The dispatcher's transcript reader (children included), set by `server.ts` where it is built. */
let transcriptUsage: ((sessionKey: string) => SessionUsage) | null = null;
export function setTranscriptUsageReader(fn: ((sessionKey: string) => SessionUsage) | null): void {
  transcriptUsage = fn;
}

export function liveConsumptionDeps(ctx: AppContext): ConsumptionDeps {
  const tasks = createTaskService(ctx.db);
  const nameByBoard = (): Map<string, string> => {
    const m = new Map<string, string>();
    for (const p of ctx.projectStore.list()) m.set(projectIdForPath(p.path), p.name);
    return m;
  };
  const reading = (u: SessionUsage, source: UsageReading["source"]): UsageReading => ({
    inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens, billableTokens: u.billableTokens, source,
  });
  const local = (): string | null => { try { return ctx.machineStore.upsertLocal().id; } catch { return null; } };

  return {
    now: () => Date.now(),
    async table() {
      const fleet = await getFleetUsage();
      const t = lastFleetTable();
      if (!fleet.supported || !t) return null;
      const cpuOf = t.instantCpu;
      return {
        rows: t.rows.map((r) => ({ pid: r.pid, ppid: r.ppid, memKB: r.footprintKB ?? r.rssKB, cpu: cpuOf ? cpuOf(r) : null, command: r.command })),
        roots: resolveFleetRoots(t.rows, process.pid).map((r) => ({ id: r.kind, pid: r.pid })),
        cores: fleetCpuCores(),
        responsibleOf: responsiblePid,
      };
    },
    tasks() {
      const here = local();
      return tasks.list({ scope: "all", status: "in_progress", rootsOnly: true, includeOrphanSubtasks: true }).map((t) => ({
        id: t.id, text: t.text, projectId: t.projectId, model: t.model ?? null,
        machineId: t.machineId && t.machineId !== here ? t.machineId : null,
        assignedTopicId: t.assignedTopicId ?? null,
        inProgressAt: t.inProgressAt ?? null, updatedAt: t.updatedAt ?? null,
        agentTokens: t.agentTokens ?? 0, awaitingAnswer: t.awaitingAnswer === true,
        from: t.runInitiatorDeviceName ?? t.runInitiatorPersonName ?? null,
      }));
    },
    terminals: () => listTerminalOwners(),
    cliPids: () => listSessionCliPids(),
    nativeCommands: () => listNativeCommands().map((c) => ({ sessionKey: c.sessionKey, pid: c.pid })),
    scriptOwners: () => listSessionOwnedProcesses(),
    unownedScripts: () => listUnownedScriptPids(),
    usageOf(sessionKey) {
      const native = readNativeUsage(sessionKey);
      if (native) return reading(native, "native");
      if (!transcriptUsage) return null;
      try { return reading(transcriptUsage(sessionKey), "transcript"); } catch { return null; }
    },
    topicsBySessionKey(keys) {
      const out = new Map<string, { id: string; name: string; projectPath: string | null; model: string | null }>();
      if (keys.length === 0) return out;
      try {
        const holes = keys.map(() => "?").join(",");
        const rows = ctx.db.prepare(`SELECT id, name, session_key, project_path, model FROM topics WHERE session_key IN (${holes})`)
          .all(...keys) as Array<{ id: string; name: string; session_key: string; project_path: string | null; model: string | null }>;
        for (const r of rows) out.set(r.session_key, { id: r.id, name: r.name, projectPath: r.project_path, model: r.model });
      } catch { /* a topic that cannot be read is a session without a name: its key stands in */ }
      return out;
    },
    projectName(src) {
      if (src.boardId) return projectLabel(src.boardId, nameByBoard());
      if (!src.path) return null;
      const known = ctx.projectStore.list().find((p) => p.path === src.path);
      return known?.name ?? (src.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null);
    },
    remoteMachineName(machineId) {
      if (!machineId) return null;
      try { return ctx.machineStore.get(machineId)?.name ?? machineId; } catch { return machineId; }
    },
  };
}

let service: SessionConsumptionService | null = null;

/** One service per process: the rate tracker and the cache are memory, two instances would tell two histories. */
export function getSessionConsumption(ctx: AppContext): SessionConsumptionService {
  if (!service) service = createSessionConsumption(liveConsumptionDeps(ctx));
  return service;
}
