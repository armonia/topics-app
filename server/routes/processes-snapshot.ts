import { isTopicsSpawned, type OwnedScript } from "../lib/ghost-script";
import type { AppContext } from "../types";
import { getDescendantPids } from "../lib/process-tree";
import { getListeningPorts } from "../lib/listening-ports";
import { stripAnsi } from "../utils/path-env";
import { loadProcessRegistry } from "./processes-persist";
import { type ScriptProcess, recentScripts, runningScripts } from "./processes-state";

// ── Port detection per process ───────────────────────────────────────────────

export async function getPortsForProcess(pid: number): Promise<number[]> {
  const allPorts = await getListeningPorts();
  const treePids = await getDescendantPids(pid);
  return allPorts
    .filter(p => treePids.has(p.pid))
    .map(p => p.port);
}

/** Batched port lookup for several tracked pids at once: one lsof + one ps-table
 *  snapshot are shared (both already cached), and the cached port list is walked
 *  ONCE — each listening port is attributed to the first owning tree instead of
 *  re-filtering the whole list per pid (the per-process getPortsForProcess path).
 *  Returns pid → ports[]. */
export async function getPortsForProcesses(pids: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (pids.length === 0) return out;
  const allPorts = await getListeningPorts();
  // Descendant closure per tracked pid (shares the cached ps proc table).
  const trees: { pid: number; tree: Set<number> }[] = [];
  for (const pid of pids) {
    out.set(pid, []);
    trees.push({ pid, tree: await getDescendantPids(pid) });
  }
  // Single pass over the cached port list: attribute each port to the first
  // tracked pid whose descendant set owns it.
  for (const lp of allPorts) {
    const owner = trees.find(t => t.tree.has(lp.pid));
    if (owner) out.get(owner.pid)!.push(lp.port);
  }
  return out;
}

// Build current scripts list (without port detection for WS broadcasts — ports are fetched on GET)
// Esportata per i test: è la lista che viaggia sulla WS, e deve dire le stesse
// cose della risposta HTTP — se le due divergono la divergenza si vede solo dal vivo.
/**
 * The processes Topics itself spawned that are still running (manifest scripts
 * and `run_command`s), with pid, pidLstart and projectPath. The worktree guards
 * read it: the eviction before a removal (worktree-manager, point 1 of task
 * e3240a22), the GC's «something alive inside» (point 3) and the ghost reaper.
 */
export function listOwnedScripts(): OwnedScript[] {
  loadProcessRegistry();
  return Array.from(runningScripts.values())
    .filter(sp => isTopicsSpawned(sp.source) && sp.status === "running" && sp.pid)
    .map(sp => ({
      processId: sp.processId,
      pid: sp.pid,
      pidLstart: sp.pidLstart,
      projectPath: sp.projectPath,
      source: sp.cmd ? "command" as const : "script" as const,
      status: sp.status,
    }));
}

/**
 * The running processes a session launched, with the session key and the pid:
 * the per-session consumption bills their trees to that session. A script the
 * UI started for a project has no session and is not here (it is `unowned`
 * work, reported apart and never shared out).
 */
export function listSessionOwnedProcesses(): { sessionKey: string; pid: number }[] {
  loadProcessRegistry();
  const out: { sessionKey: string; pid: number }[] = [];
  for (const sp of runningScripts.values()) {
    if (sp.status !== "running" || !sp.pid) continue;
    const sessionKey = sp.cmd?.sessionKey ?? sp.cardRun?.sessionKey ?? sp.agentRun?.sessionKey ?? sp.shell?.sessionKey ?? null;
    if (sessionKey) out.push({ sessionKey, pid: sp.pid });
  }
  return out;
}

/** Pids of the running scripts no session owns: a project's dev server, a build somebody started from the UI. */
export function listUnownedScriptPids(): number[] {
  loadProcessRegistry();
  const out: number[] = [];
  for (const sp of runningScripts.values()) {
    if (sp.status !== "running" || !sp.pid || !isTopicsSpawned(sp.source)) continue;
    if (!(sp.cmd?.sessionKey ?? sp.cardRun?.sessionKey ?? sp.agentRun?.sessionKey ?? sp.shell?.sessionKey)) out.push(sp.pid);
  }
  return out;
}

/**
 * A row as it travels, ONE shape for the WebSocket frame and the HTTP answer:
 * built in two places, the two lists had already drifted once. The shell id
 * rides on the frame too: the chat's cards find their shell BY id, and the
 * broadcast is what arrives first when a shell starts or changes (the poll
 * can be 15 s behind). A command carries its topic and whether it was stopped.
 */
export function publicRow(sp: ScriptProcess) {
  return {
    processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
    projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
    startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
    source: sp.source ?? "script",
    ...(sp.shell ? { shellId: sp.shell.shellId, topicId: sp.shell.topicId } : {}),
    ...(sp.cmd ? {
      topicId: sp.cmd.topicId,
      ...(sp.cmd.stopped ? { stopped: true as const } : {}),
      ...(sp.cmd.closing ? { closing: true as const } : {}),
      ...(sp.cmd.stopFailed ? { stopFailed: true as const } : {}),
    } : {}),
    ...(sp.cardRun ? {
      topicId: sp.cardRun.topicId,
      ...(sp.stopped ? { stopped: true as const } : {}),
      ...(sp.closing ? { closing: true as const } : {}),
      ...(sp.stopFailed ? { stopFailed: true as const } : {}),
    } : {}),
  };
}

export function getScriptsSnapshot(): any[] {
  loadProcessRegistry();
  return [...runningScripts.values(), ...recentScripts].map(sp => ({ ...publicRow(sp), ports: [] as number[] }));
}

/**
 * The line a row is printing now, for a one-line preview (`scripts:output`,
 * the chat's live work): the line being written, else the last one that is
 * not blank. A progress bar redraws its line with `\r`: its last drawing.
 */
export function lastLineOf(sp: ScriptProcess | undefined): string {
  if (!sp) return "";
  const clip = (line: string) => {
    const shown = stripAnsi(line.slice(line.lastIndexOf("\r", line.length - 2) + 1)).trim();
    return shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
  };
  for (const pending of [sp.followPending, sp.pendingLine]) if (pending && clip(pending)) return clip(pending);
  for (let i = sp.output.length - 1; i >= Math.max(0, sp.output.length - 50); i--) {
    const line = clip(sp.output[i] ?? "");
    if (line) return line;
  }
  return "";
}

// Debounced output notification
let outputNotifyTimer: ReturnType<typeof setTimeout> | null = null;
const pendingOutputIds = new Set<string>();

export function notifyScriptOutput(ctx: AppContext, processId: string) {
  pendingOutputIds.add(processId);
  if (!outputNotifyTimer) {
    outputNotifyTimer = setTimeout(() => {
      for (const id of pendingOutputIds) {
        // The line it is printing rides along: the chat's live work previews it without a read per row.
        ctx.broadcastToAll({ type: 'scripts:output', processId: id, line: lastLineOf(runningScripts.get(id)) });
      }
      pendingOutputIds.clear();
      outputNotifyTimer = null;
    }, 1000); // max 1 notification per second
  }
}

export function broadcastScriptsUpdate(ctx: AppContext) {
  ctx.broadcastToAll({ type: 'scripts:updated', scripts: getScriptsSnapshot() });
}
