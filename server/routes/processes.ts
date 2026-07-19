import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { appendFile as appendFileAsync, readFile as readFileAsync, writeFile as writeFileAsync } from "fs/promises";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";
import { augmentEnv, wrapPty, stripAnsi } from "../utils/path-env";
import { resolveStateDir } from "../lib/data-dir";
import { getTerminalSessionById } from "./terminal";

interface ScriptProcess {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: "running" | "done" | "error";
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  output: string[];       // circular buffer lines
  outputBytes: number;
  proc: ReturnType<typeof Bun.spawn> | null;
  /** Byte size of the on-disk .log — tracked in memory so the per-chunk write
   *  path never stats the file. The log is per-processId (unique per spawn),
   *  so it always starts at 0. Not persisted. */
  logBytes?: number;
  /** Per-process async write chain: keeps chunk appends + rotation ordered
   *  without blocking the event loop (the old appendFileSync/statSync ran on
   *  EVERY stdout/stderr chunk of every tracked script). Not persisted. */
  logQueue?: Promise<void>;
  /** 'script' = launched by Topics (run_script / UI), output captured. 'detected'
   *  = a listening server found under a Claude PTY that Topics did NOT spawn, so
   *  we have its pid/ports but not its stdout. Defaults to 'script'. */
  source?: "script" | "detected";
}

// Serializable subset for persistence
interface PersistedScript {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: "running" | "done" | "error";
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
}

const MAX_OUTPUT_BYTES = 500 * 1024; // ~500KB per process
const MAX_RECENT = 10;

const runningScripts = new Map<string, ScriptProcess>();
const recentScripts: ScriptProcess[] = [];

// ── Persistence ──────────────────────────────────────────────────────────────

let PERSIST_DIR = "";

function getPersistDir(): string {
  if (!PERSIST_DIR) {
    PERSIST_DIR = join(resolveStateDir(process.cwd()), ".state");
    mkdirSync(PERSIST_DIR, { recursive: true });
  }
  return PERSIST_DIR;
}

function persistPath(): string {
  return join(getPersistDir(), "scripts.json");
}

function saveState() {
  invalidateScriptsCache();
  const data = {
    // Detected processes are ephemeral (re-discovered every detector cycle) and
    // were not spawned by us, so never persist them — only Topics-launched scripts.
    running: Array.from(runningScripts.values()).filter(sp => sp.source !== "detected").map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
    })),
    recent: recentScripts.map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
    })),
  };
  try { writeFileSync(persistPath(), JSON.stringify(data)); } catch {}
}

function loadState() {
  try {
    if (!existsSync(persistPath())) return;
    const data = JSON.parse(readFileSync(persistPath(), "utf-8"));

    // Restore recent scripts (completed ones)
    if (Array.isArray(data.recent)) {
      for (const r of data.recent) {
        const sp: ScriptProcess = {
          ...r,
          output: [],
          outputBytes: 0,
          proc: null,
        };
        // Load output from log file
        const logPath = join(getPersistDir(), "scripts", `${r.processId}.log`);
        try {
          if (existsSync(logPath)) {
            const logContent = readFileSync(logPath, "utf-8");
            sp.output = logContent.split("\n");
            sp.outputBytes = logContent.length;
          }
        } catch {}
        recentScripts.push(sp);
      }
    }

    // For "running" scripts from a previous server session:
    // Check if the PID is still alive. If yes, re-adopt; if no, mark as error.
    if (Array.isArray(data.running)) {
      for (const r of data.running as PersistedScript[]) {
        if (r.pid && isPidAlive(r.pid)) {
          // Process is still alive — re-track it (we can't re-capture stdout,
          // but we can track its PID for port detection and stop)
          const sp: ScriptProcess = {
            ...r,
            status: "running",
            output: [],
            outputBytes: 0,
            proc: null, // We don't have the handle, but we have the PID
          };
          // Load output from log file
          const logPath = join(getPersistDir(), "scripts", `${r.processId}.log`);
          try {
            if (existsSync(logPath)) {
              const logContent = readFileSync(logPath, "utf-8");
              sp.output = logContent.split("\n");
              sp.outputBytes = logContent.length;
            } else {
              sp.output = ["[server restarted — previous output lost]"];
              sp.outputBytes = 40;
            }
          } catch {
            sp.output = ["[server restarted — previous output lost]"];
            sp.outputBytes = 40;
          }
          runningScripts.set(r.processId, sp);

          // Poll for exit in background
          pollPidExit(sp);
        } else {
          // Process died while server was down
          const sp: ScriptProcess = {
            ...r,
            status: "error",
            completedAt: r.completedAt || new Date().toISOString(),
            exitCode: r.exitCode ?? -1,
            output: [],
            outputBytes: 0,
            proc: null,
          };
          // Load output from log file
          const deadLogPath = join(getPersistDir(), "scripts", `${r.processId}.log`);
          try {
            if (existsSync(deadLogPath)) {
              const logContent = readFileSync(deadLogPath, "utf-8");
              sp.output = logContent.split("\n");
              sp.outputBytes = logContent.length;
            }
          } catch {}
          addToRecent(sp);
        }
      }
    }

    // Cleanup old log files for completed processes older than 7 days
    try {
      const scriptsDir = join(getPersistDir(), "scripts");
      if (existsSync(scriptsDir)) {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        for (const file of readdirSync(scriptsDir)) {
          if (!file.endsWith('.log')) continue;
          const processId = file.replace('.log', '');
          // Keep logs for running processes
          if (runningScripts.has(processId)) continue;
          // Check if recent and not old
          const recent = recentScripts.find(s => s.processId === processId);
          if (recent?.completedAt && (now - new Date(recent.completedAt).getTime()) < SEVEN_DAYS) continue;
          // Remove old log
          try { unlinkSync(join(scriptsDir, file)); } catch {}
        }
      }
    } catch {}
  } catch {}
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check
  } catch {
    return false;
  }
  // signal 0 succeeds for zombies too — check actual state via ps
  try {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    const stat = new TextDecoder().decode(result.stdout).trim();
    if (stat.startsWith("Z")) return false; // zombie
  } catch {}
  return true;
}

let _broadcastCtx: AppContext | null = null;

function pollPidExit(sp: ScriptProcess) {
  const check = () => {
    if (!sp.pid || !isPidAlive(sp.pid)) {
      sp.status = "done";
      sp.completedAt = new Date().toISOString();
      sp.proc = null;
      runningScripts.delete(sp.processId);
      addToRecent(sp);
      saveState();
      if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
      return;
    }
    setTimeout(check, 3000);
  };
  setTimeout(check, 3000);
}

// ── Port detection per process ───────────────────────────────────────────────

// Cache lsof results for a short time to avoid running it on every request
let cachedPorts: { port: number; pid: number; command: string }[] = [];
let cachedPortsAt = 0;
const PORT_CACHE_TTL = 5000;

export async function getListeningPorts(): Promise<{ port: number; pid: number; command: string }[]> {
  const now = Date.now();
  if (now - cachedPortsAt < PORT_CACHE_TTL) return cachedPorts;

  try {
    const proc = Bun.spawn(["/usr/sbin/lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const ports: { port: number; pid: number; command: string }[] = [];
    const seen = new Set<number>();
    for (const line of output.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const cmd = parts[0];
      const pid = parseInt(parts[1], 10);
      const nameField = parts[8] || "";
      const portMatch = nameField.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push({ port, pid, command: cmd });
    }
    ports.sort((a, b) => a.port - b.port);
    cachedPorts = ports;
    cachedPortsAt = now;
    return ports;
  } catch {
    return cachedPorts;
  }
}

// Top CPU consumers, system-wide — so the status dropdown can answer "why is my
// PC load high?" with the actual culprits instead of a vague verdict. One cached
// `ps … -r` (sort by CPU) snapshot; refreshed at most every TOP_PROCS_TTL so a
// dropdown polling every few seconds stays cheap.
let cachedTopProcs: { pid: number; cpu: number; command: string }[] = [];
let cachedTopProcsAt = 0;
const TOP_PROCS_TTL = 3000;

export async function getTopCpuProcesses(limit = 6): Promise<{ pid: number; cpu: number; command: string }[]> {
  const now = Date.now();
  if (now - cachedTopProcsAt < TOP_PROCS_TTL && cachedTopProcs.length) return cachedTopProcs.slice(0, limit);
  try {
    // -A all procs, -c accounting (short) command name, -o columns, -r sort by CPU desc.
    const proc = Bun.spawn(["ps", "-Aco", "pid,pcpu,comm", "-r"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const rows: { pid: number; cpu: number; command: string }[] = [];
    for (const line of text.split("\n").slice(1)) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
      if (!m) continue;
      const cpu = parseFloat(m[2]);
      if (!(cpu > 0)) continue;
      rows.push({ pid: +m[1], cpu: Math.round(cpu), command: m[3].trim() });
      if (rows.length >= 12) break;
    }
    cachedTopProcs = rows;
    cachedTopProcsAt = now;
    return rows.slice(0, limit);
  } catch {
    return cachedTopProcs.slice(0, limit);
  }
}

// Cached process table (ppid → child pids). ONE `ps` snapshot replaces the old
// recursive `pgrep -P` storm, which spawned one process per tree node, per
// session, every detector cycle (and per script on every GET /api/scripts) — a
// real subprocess/CPU drain that contended with the renderer. Refreshed at most
// every PROC_TABLE_TTL; all getDescendantPids calls in a cycle share it.
let _procTableAt = 0;
let _childrenByPpid: Map<number, number[]> = new Map();
const PROC_TABLE_TTL = 2000;

async function getProcTable(): Promise<Map<number, number[]>> {
  const now = Date.now();
  if (now - _procTableAt < PROC_TABLE_TTL && _childrenByPpid.size) return _childrenByPpid;
  const children = new Map<number, number[]>();
  try {
    const proc = Bun.spawn(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      const arr = children.get(ppid);
      if (arr) arr.push(pid); else children.set(ppid, [pid]);
    }
    _childrenByPpid = children;
    _procTableAt = now;
  } catch { /* keep the previous table on transient failure */ }
  return _childrenByPpid;
}

async function getDescendantPids(pid: number): Promise<Set<number>> {
  const children = await getProcTable();
  const out = new Set<number>([pid]);
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p) ?? []) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

/**
 * Per-pid identity snapshot (`pid → lstart`) for the delayed-SIGKILL guard.
 * A PID can be recycled by the OS within the 5s SIGTERM→SIGKILL grace; killing
 * by number alone could then SIGKILL an unrelated fresh process. The start
 * timestamp disambiguates: a reused pid has a different lstart.
 */
async function getPidStartTimes(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  try {
    const proc = Bun.spawn(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) out.set(+m[1], m[2]);
    }
  } catch { /* transient ps failure → empty map → the guard skips the SIGKILL */ }
  return out;
}

async function getPortsForProcess(pid: number): Promise<number[]> {
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
async function getPortsForProcesses(pids: number[]): Promise<Map<number, number[]>> {
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function addToRecent(sp: ScriptProcess) {
  recentScripts.unshift(sp);
  if (recentScripts.length > MAX_RECENT) recentScripts.pop();
}

function appendOutput(sp: ScriptProcess, text: string) {
  if (!text) return;
  // Ring buffer, bulk eviction: push everything, then splice ONE run off the
  // front until back under the cap. The old per-line `Array.shift()` loop was
  // O(n) per evicted line (each shift re-indexes the whole array) on the hot
  // per-chunk path of every tracked script. Keeps the original semantics:
  // newest lines win, and a single line larger than the cap is kept alone.
  const lines = text.split("\n");
  for (const line of lines) sp.outputBytes += line.length;
  sp.output.push(...lines);
  if (sp.outputBytes > MAX_OUTPUT_BYTES) {
    let drop = 0;
    let freed = 0;
    while (drop < sp.output.length - 1 && sp.outputBytes - freed > MAX_OUTPUT_BYTES) {
      freed += sp.output[drop].length;
      drop++;
    }
    if (drop > 0) {
      sp.output.splice(0, drop);
      sp.outputBytes -= freed;
    }
  }
  // Persist to log file — async, serialized per process. The old
  // appendFileSync + statSync (and readFileSync+writeFileSync on rotation)
  // blocked Bun's single event loop once per stdout/stderr chunk. The chain
  // keeps appends and rotation ordered; rotation is triggered off the
  // in-memory byte counter, so the write path never stats the file.
  const logPath = join(getPersistDir(), "scripts", `${sp.processId}.log`);
  sp.logQueue = (sp.logQueue ?? Promise.resolve())
    .then(async () => {
      await appendFileAsync(logPath, text);
      sp.logBytes = (sp.logBytes ?? 0) + Buffer.byteLength(text);
      // Rotation: if > 1MB, keep last 500KB
      if (sp.logBytes > 1024 * 1024) {
        const content = await readFileAsync(logPath);
        await writeFileAsync(logPath, content.subarray(Math.max(0, content.length - 500 * 1024)));
        sp.logBytes = Math.min(content.length, 500 * 1024);
      }
    })
    .catch(() => {});
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadState();
// Runs at MODULE IMPORT (before createAppContext / Bun.serve). getPersistDir()
// now resolves a writable dir, but keep this defensive so a persist-dir failure
// can never abort server boot and hang the "Launching the local engine" splash.
try {
  mkdirSync(join(getPersistDir(), "scripts"), { recursive: true });
} catch (e) {
  console.error("[processes] persist dir init failed (non-fatal):", e);
}

// ── Router ───────────────────────────────────────────────────────────────────

// ── Scripts response cache (2s TTL, invalidated on state change) ─────────
let scriptsResponseCache: { data: any; timestamp: number } | null = null;
const SCRIPTS_CACHE_TTL = 2000;

function invalidateScriptsCache() {
  scriptsResponseCache = null;
}

// Build current scripts list (without port detection for WS broadcasts — ports are fetched on GET)
function getScriptsSnapshot(): any[] {
  const running = Array.from(runningScripts.values()).map(sp => ({
    processId: sp.processId,
    scriptName: sp.scriptName,
    command: sp.command,
    projectPath: sp.projectPath,
    status: sp.status,
    pid: sp.pid,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    exitCode: sp.exitCode,
    source: sp.source ?? "script",
    ports: [] as number[],
  }));
  const recent = recentScripts.map(sp => ({
    processId: sp.processId,
    scriptName: sp.scriptName,
    command: sp.command,
    projectPath: sp.projectPath,
    status: sp.status,
    pid: sp.pid,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    exitCode: sp.exitCode,
    source: sp.source ?? "script",
    ports: [] as number[],
  }));
  return [...running, ...recent];
}

// Debounced output notification
let outputNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOutputIds = new Set<string>();

function notifyScriptOutput(ctx: AppContext, processId: string) {
  pendingOutputIds.add(processId);
  if (!outputNotifyTimer) {
    outputNotifyTimer = setTimeout(() => {
      for (const id of pendingOutputIds) {
        ctx.broadcastToAll({ type: 'scripts:output', processId: id });
      }
      pendingOutputIds.clear();
      outputNotifyTimer = null;
    }, 1000); // max 1 notification per second
  }
}

function broadcastScriptsUpdate(ctx: AppContext) {
  ctx.broadcastToAll({ type: 'scripts:updated', scripts: getScriptsSnapshot() });
}

// ── Review-ready preview servers ─────────────────────────────────────────────
// The preview-manager boots one dev server per task from its worktree at
// review-time. Surface it in the Processes panel (Stop button + port link) so a
// human can see/kill it. Registered as a `script` entry (not `detected`, which
// the detector reconcile would reap) keyed by task, so teardown removes exactly
// one. Ports fill in via the lsof-by-pid path on the HTTP serialize.
const previewProcessKey = (taskId: string) => `preview:${taskId.slice(0, 8)}`;

export function registerPreviewProcess(entry: { taskId: string; port: number; pid: number | null; command: string; cwd: string }): void {
  const processId = previewProcessKey(entry.taskId);
  runningScripts.set(processId, {
    processId,
    scriptName: `preview :${entry.port}`,
    command: entry.command,
    projectPath: entry.cwd,
    status: "running",
    pid: entry.pid,
    startedAt: new Date().toISOString(),
    output: [`[anteprima task ${entry.taskId.slice(0, 8)} — http://localhost:${entry.port}]`],
    outputBytes: 0,
    proc: null,
    source: "script",
  });
  saveState();
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

export function unregisterPreviewProcess(taskId: string): void {
  if (runningScripts.delete(previewProcessKey(taskId))) {
    saveState();
    if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
  }
}

// ── Auto-detection of servers started inside Claude PTY sessions ──────────────
// Claude often starts a dev server with a bare shell command (`bun run dev`)
// instead of the run_script MCP tool. That process is a descendant of the
// session's PTY but is never registered, so it's invisible in the Processes
// panel. This detector periodically maps listening ports → owning pid → which
// Claude PTY tree they belong to, and registers each as a tracked
// (source:'detected') ScriptProcess so it shows up live with a working Stop.
// Attribution is by PROCESS TREE (not cwd), so Topics' own servers and unrelated
// machine processes are never mis-claimed.

interface DetectionSession { ptyPid: number; cwd: string; sessionId: string; name: string }
type DetectionSource = () => DetectionSession[];

let _detectionSource: DetectionSource | null = null;
let _detectionTimer: ReturnType<typeof setInterval> | null = null;
const DETECTION_INTERVAL_MS = 4000;

/** Wire the source of active Claude sessions and start the detection loop.
 *  Called once from server.ts after the terminal + processes routers exist. */
export function startProcessDetection(ctx: AppContext, getSessions: DetectionSource): void {
  _detectionSource = getSessions;
  if (_detectionTimer) return;
  _detectionTimer = setInterval(() => { runDetectionCycle(ctx).catch((e) => console.error('[detect] cycle error:', e?.message || e)); }, DETECTION_INTERVAL_MS);
  // Never let this 4s poller keep the process alive on its own — it's the one
  // long-lived timer that was missing from gracefulShutdown()'s teardown list.
  if (typeof _detectionTimer.unref === "function") _detectionTimer.unref();
  runDetectionCycle(ctx).catch((e) => console.error('[detect] cycle error:', e?.message || e)); // run once promptly
}

function detectedKey(pid: number): string { return `detected:${pid}`; }

// Never register these as a "server" even if they hold a port: the claude
// binary/daemon itself and the stdio Topics MCP bridge (defensive).
function isNoiseCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return c.includes("claude") || c.includes("topics-mcp");
}

/** Full argv of a pid (`ps -o command=`), for a readable label. Falls back to "". */
async function getCommandForPid(pid: number): Promise<string> {
  try {
    const proc = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out.split("\n")[0] || "";
  } catch { return ""; }
}

// The port Topics itself listens on — never report it as a detected server.
const OWN_PORT = Number(process.env.BUN_PORT) || 3333;
// Sessions whose cwd is under one of these roots are tooling/infra, not user
// projects, so we don't surface the long-running services living there (the
// Claude config tree holds the user's router / vector DB / memory daemons). A
// session in a real project dir (Projects/, Sites/, …) is detected normally.
const INFRA_CWD_PREFIXES = [`${process.env.HOME || ""}/.claude`].filter(p => p.length > 1);
function isInfraCwd(cwd: string): boolean {
  return INFRA_CWD_PREFIXES.some(p => cwd === p || cwd.startsWith(p + "/"));
}
// A session cwd that is HOME (or an ancestor of it, or `/`) is too broad: cwd
// attribution would then claim EVERY listening process under home (infra,
// Electron, unrelated servers). Only sessions cwd'd into a specific project dir
// get cwd-based detection. (Tree-based detection still applies to them.)
const _HOME = process.env.HOME || "";
function isBroadCwd(cwd: string): boolean {
  if (!cwd || cwd === "/" || cwd === _HOME) return true;
  return _HOME.length > 1 && (_HOME === cwd || _HOME.startsWith(cwd + "/"));
}

/** cwd of each pid via one batched lsof. Pids without a cwd are omitted. */
async function getProcessCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    const proc = Bun.spawn(["/usr/sbin/lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    let cur = 0;
    for (const line of text.split("\n")) {
      if (line[0] === "p") cur = parseInt(line.slice(1), 10);
      else if (line[0] === "n" && cur) out.set(cur, line.slice(1));
    }
  } catch {}
  return out;
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

async function runDetectionCycle(ctx: AppContext): Promise<void> {
  if (!_detectionSource) return;
  // Active Claude sessions in REAL project dirs (skip the infra/config tree).
  const sessions = _detectionSource().filter(s => s.ptyPid > 0 && !isInfraCwd(s.cwd));

  // No eligible Claude sessions → reap any leftover detected entries and stop.
  if (sessions.length === 0) {
    let changed = false;
    for (const sp of [...runningScripts.values()]) {
      if (sp.source === "detected") { runningScripts.delete(sp.processId); changed = true; }
    }
    if (changed) broadcastScriptsUpdate(ctx);
    return;
  }

  const allPorts = await getListeningPorts();

  // Ports already owned by a Topics-launched (script) process — don't double-list.
  const managedPorts = new Set<number>();
  for (const sp of runningScripts.values()) {
    if (sp.source === "detected" || !sp.pid) continue;
    for (const p of await getPortsForProcess(sp.pid)) managedPorts.add(p);
  }

  // Candidate listening ports: not Topics' own, not already a tracked script,
  // not the claude binary / MCP bridge itself.
  const candidates = allPorts.filter(lp =>
    lp.port !== OWN_PORT && !managedPorts.has(lp.port) && !isNoiseCommand(lp.command));

  // Attribute each candidate to a session by, in order:
  //  (1) cwd — it runs inside the session's project dir. PRIMARY signal: a dev
  //      server Claude backgrounds reparents to launchd (ppid 1), so a
  //      process-tree walk from the PTY misses it, but its cwd stays in the dir.
  //  (2) tree — it's a live descendant of the session's PTY (catches a server
  //      whose cwd is elsewhere, e.g. started in /tmp).
  const pidSet = [...new Set(candidates.map(c => c.pid))];
  const cwds = await getProcessCwds(pidSet);
  const trees = new Map<string, Set<number>>();
  for (const s of sessions) trees.set(s.sessionId, await getDescendantPids(s.ptyPid));
  // cwd-attribution candidates: specific project dirs only (a session cwd'd at
  // HOME would otherwise claim everything under it). Longest (most specific) wins
  // when nested. Broad-cwd sessions still get TREE attribution below.
  const byDepth = sessions.filter(s => !isBroadCwd(s.cwd)).sort((a, b) => b.cwd.length - a.cwd.length);

  const desired = new Map<string, { pid: number; cwd: string; lsofCmd: string; ports: number[] }>();
  for (const lp of candidates) {
    const pcwd = cwds.get(lp.pid);
    const owner = (pcwd ? byDepth.find(s => isWithin(pcwd, s.cwd)) : undefined)
      || sessions.find(s => trees.get(s.sessionId)?.has(lp.pid));
    if (!owner) continue;
    if (lp.pid === owner.ptyPid) continue; // the claude process itself
    const key = detectedKey(lp.pid);
    const entry = desired.get(key);
    if (entry) { if (!entry.ports.includes(lp.port)) entry.ports.push(lp.port); }
    else desired.set(key, { pid: lp.pid, cwd: owner.cwd, lsofCmd: lp.command, ports: [lp.port] });
  }

  let changed = false;

  // Reap detected entries whose server no longer holds a port (it stopped).
  for (const sp of [...runningScripts.values()]) {
    if (sp.source !== "detected") continue;
    if (!desired.has(sp.processId)) { runningScripts.delete(sp.processId); changed = true; }
  }

  // Register newly-seen detected servers (existing ones keep their entry; ports
  // refresh via the HTTP serialize path).
  for (const [key, d] of desired) {
    if (runningScripts.has(key)) continue;
    const full = await getCommandForPid(d.pid);
    runningScripts.set(key, {
      processId: key,
      scriptName: d.lsofCmd || "server",                 // short label (e.g. "node", "bun")
      command: full || d.lsofCmd,                        // full argv when available
      projectPath: d.cwd,
      status: "running",
      pid: d.pid,
      startedAt: new Date().toISOString(),
      output: ["[auto-detected running server — Topics did not launch it, so its logs are not captured here]"],
      outputBytes: 0,
      proc: null,
      source: "detected",
    });
    changed = true;
  }

  if (changed) broadcastScriptsUpdate(ctx);
}

/**
 * Read the `scripts` map from a project's package.json. Returns null when the
 * file is absent or unparseable. Used to gate the session-keyed (MCP) run
 * endpoint: a bypass-permission agent may only launch declared scripts, never
 * an arbitrary name. The UI endpoint stays ungated — it already only offers
 * package.json scripts, and `npm run <missing>` fails harmlessly anyway.
 */
function readPackageScripts(projectPath: string): Record<string, string> | null {
  try {
    const pkgPath = join(projectPath, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const scripts = pkg?.scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return null;
  }
}

export function createProcessesRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;
  _broadcastCtx = ctx; // store for pollPidExit callbacks

  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  /**
   * Spawn `npm run <scriptName>` in projectPath, register it in the running
   * map, wire stdout/stderr streaming + exit handling, and return the public
   * payload. Shared by the UI endpoint (POST /api/scripts/run) and the
   * session-keyed MCP endpoint (POST /api/sessions/:sessionKey/scripts/run).
   */
  function startScriptProcess(
    projectPath: string,
    scriptName: string,
    useTty: boolean,
  ): { processId: string; scriptName: string; pid: number | null; startedAt: string } {
    const processId = crypto.randomUUID();
    const command = `npm run ${scriptName}`;
    const argv = useTty
      ? wrapPty(["npm", "run", scriptName])
      : ["npm", "run", scriptName];

    const proc = Bun.spawn(argv, {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: augmentEnv(process.env, {
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        HOST: "0.0.0.0",
        NODE_ENV: "development",
        npm_config_yes: "true",
      }),
    });

    const sp: ScriptProcess = {
      processId,
      scriptName,
      command,
      projectPath,
      status: "running",
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      output: [],
      outputBytes: 0,
      proc,
    };

    runningScripts.set(processId, sp);
    saveState();
    broadcastScriptsUpdate(ctx);

    if (proc.stdout) {
      (async () => {
        const reader = proc.stdout!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            appendOutput(sp, useTty ? stripAnsi(chunk) : chunk);
            notifyScriptOutput(ctx, processId);
          }
        } catch {}
      })();
    }

    if (proc.stderr) {
      (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            appendOutput(sp, useTty ? stripAnsi(chunk) : chunk);
            notifyScriptOutput(ctx, processId);
          }
        } catch {}
      })();
    }

    proc.exited.then((exitCode) => {
      sp.status = exitCode === 0 ? "done" : "error";
      sp.exitCode = exitCode;
      sp.completedAt = new Date().toISOString();
      sp.proc = null;
      runningScripts.delete(processId);
      addToRecent(sp);
      saveState();
      broadcastScriptsUpdate(ctx);
    });

    return { processId, scriptName, pid: proc.pid, startedAt: sp.startedAt };
  }

  // ── Session scoping helpers (shared by MCP-bridge session endpoints) ──────

  /** Resolve a sessionKey to its topic's working directory, or an error Response. */
  function resolveSessionCwd(sessionKey: string): { path: string } | { error: Response } {
    const topic = ctx.getTopicBySessionKey(sessionKey);
    if (topic) {
      const path = ctx.resolveTopicCwd(topic);
      if (!path) return { error: json({ error: "This topic has no project directory — bind it to a project first" }, 400) };
      return { path };
    }
    // Terminal-driven: a Claude Code *terminal* tab spawns its MCP bridge with the
    // terminal session id as the sessionKey (see writeMcpConfigForSession), which
    // matches no chat topic. Mirror the open-pane fallback (topics.ts) and resolve
    // the terminal's own working directory, so list_processes / run_script /
    // read_process_output / stop_process work from a terminal too instead of 404ing
    // "No topic bound to this session".
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) return { path: term.cwd };
    return { error: json({ error: "No topic bound to this session" }, 404) };
  }

  const getScript = (id: string): ScriptProcess | undefined =>
    runningScripts.get(id) || recentScripts.find(r => r.processId === id);

  /** Build the `{ scripts }` payload, optionally filtered to one project path. */
  async function serializeScripts(filterCwd?: string): Promise<{ scripts: any[] }> {
    const match = (sp: ScriptProcess) => !filterCwd || sp.projectPath === filterCwd;
    const running = Array.from(runningScripts.values()).filter(match);
    // One batched port lookup for all running pids (shared lsof + ps snapshot,
    // single pass over the cached port list) instead of per-process.
    const portsByPid = await getPortsForProcesses(
      running.map(sp => sp.pid).filter((p): p is number => !!p),
    );
    const runningList = running.map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
      source: sp.source ?? "script",
      ports: sp.pid ? (portsByPid.get(sp.pid) ?? []) : [],
    }));
    const recentList = recentScripts.filter(match).map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
      source: sp.source ?? "script",
      ports: [] as number[],
    }));
    return { scripts: [...runningList, ...recentList] };
  }

  const outputPayload = (sp: ScriptProcess, offset: number) => ({
    output: sp.output.slice(offset).join("\n"),
    offset: sp.output.length,
    done: sp.status !== "running",
    status: sp.status,
    exitCode: sp.exitCode,
  });

  /** Terminate a running script (process-group kill + delayed SIGKILL) and clean up. */
  function killRunningScript(sp: ScriptProcess): void {
    if (sp.source === "detected") {
      // We didn't spawn it (no `proc`, no exit handler). Kill the pid + its
      // descendant tree directly — NOT a process-group kill, to avoid any chance
      // of signalling the Claude PTY's group. Remove it immediately so Stop feels
      // instant; the detector confirms on its next cycle.
      const dpid = sp.pid;
      runningScripts.delete(sp.processId);
      if (dpid && isPidAlive(dpid)) {
        getDescendantPids(dpid).then(async tree => {
          const pids = [...tree];
          // Capture each pid's identity BEFORE signalling: the delayed SIGKILL
          // must only fire on the same incarnation (see getPidStartTimes).
          const identity = await getPidStartTimes(pids);
          for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
          setTimeout(async () => {
            const still = await getPidStartTimes(pids);
            for (const p of pids) {
              const then = identity.get(p);
              if (then && still.get(p) === then) {
                try { process.kill(p, "SIGKILL"); } catch {}
              }
            }
          }, 5000);
        }).catch(() => { try { process.kill(dpid, "SIGTERM"); } catch {} });
      }
      broadcastScriptsUpdate(ctx);
      return;
    }
    const pid = sp.pid;
    if (!pid || !isPidAlive(pid)) {
      sp.status = "error";
      sp.completedAt = new Date().toISOString();
      sp.exitCode = sp.exitCode ?? -1;
      sp.proc = null;
      runningScripts.delete(sp.processId);
      addToRecent(sp);
      saveState();
      broadcastScriptsUpdate(ctx);
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    setTimeout(() => {
      // Identity guard: if OUR process already exited (proc.exited handler set
      // status + removed it from runningScripts within the grace), the pid may
      // have been recycled by the OS — SIGKILLing it now could hit an unrelated
      // fresh process. Our own bookkeeping is the authoritative liveness check.
      if (sp.status !== "running") return;
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }, 5000);
  }

  return async function processesRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // POST /api/scripts/run — start a script (UI endpoint, ungated)
    if (method === "POST" && pathname === "/api/scripts/run") {
      const body = await readJSON(req);
      if (!body?.projectPath || !body?.scriptName) {
        return json({ error: "projectPath and scriptName required" }, 400);
      }
      // tty: true (default) wraps the command in script(1) so it gets a PTY.
      // Required by CLIs that check isatty() — supabase login, gh auth login,
      // npm login, etc. Set body.tty=false explicitly for legacy behavior.
      const useTty = body.tty !== false;
      try {
        return json(startScriptProcess(body.projectPath as string, body.scriptName as string, useTty));
      } catch (err: any) {
        return json({ error: `Failed to spawn: ${err.message}` }, 500);
      }
    }

    // POST /api/sessions/:sessionKey/scripts/run — session-keyed run (MCP bridge)
    //
    // The MCP surface for non-SDK providers: the bridge subprocess only knows
    // its sessionKey, so we resolve the topic → working directory here instead
    // of trusting a caller-supplied path. Because the spawning agent runs under
    // `--permission-mode bypassPermissions`, we gate scriptName against the
    // project's package.json — a declared script may run, an arbitrary one is
    // rejected with the list of what's available (which doubles as discovery).
    {
      const m = method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/run$/);
      if (m) {
        const sessionKey = decodeURIComponent(m[1]);
        const body = await readJSON(req);
        const scriptName = body?.scriptName;
        if (typeof scriptName !== "string" || !scriptName) {
          return json({ error: "scriptName (string) is required" }, 400);
        }

        const r = resolveSessionCwd(sessionKey);
        if ("error" in r) return r.error;
        const projectPath = r.path;

        const scripts = readPackageScripts(projectPath);
        if (!scripts) {
          return json({ error: `No package.json found in ${projectPath}` }, 400);
        }
        if (!(scriptName in scripts)) {
          const available = Object.keys(scripts);
          return json({
            error: `Script "${scriptName}" is not defined in package.json`,
            available,
          }, 400);
        }

        const useTty = body?.tty !== false;
        try {
          return json(startScriptProcess(projectPath, scriptName, useTty));
        } catch (err: any) {
          return json({ error: `Failed to spawn: ${err.message}` }, 500);
        }
      }
    }

    // GET /api/scripts — list running + recent, with per-process ports
    if (method === "GET" && pathname === "/api/scripts") {
      // Server-side cache check (2s TTL)
      if (scriptsResponseCache && Date.now() - scriptsResponseCache.timestamp < SCRIPTS_CACHE_TTL) {
        return json(scriptsResponseCache.data);
      }
      const scriptsResult = await serializeScripts();
      scriptsResponseCache = { data: scriptsResult, timestamp: Date.now() };
      return json(scriptsResult);
    }

    // GET /api/scripts/:id/output — get process output (streaming with offset)
    const outputMatch = method === "GET" && pathname.match(/^\/api\/scripts\/([^/]+)\/output$/);
    if (outputMatch) {
      const sp = getScript(outputMatch[1]);
      if (!sp) return json({ error: "Process not found" }, 404);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      return json(outputPayload(sp, offset));
    }

    // POST /api/scripts/:id/stop — kill a running process
    const stopMatch = method === "POST" && pathname.match(/^\/api\/scripts\/([^/]+)\/stop$/);
    if (stopMatch) {
      const sp = runningScripts.get(stopMatch[1]);
      if (!sp) return json({ error: "Process not found or already stopped" }, 404);
      killRunningScript(sp);
      return json({ ok: true });
    }

    // ── Session-scoped reads/controls (MCP bridge) ───────────────────────────
    // These resolve sessionKey → topic → working directory and only expose
    // processes that belong to that project, so an agent in topic A can never
    // see or kill processes started under topic B.

    // GET /api/sessions/:sessionKey/scripts
    {
      const m = method === "GET" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        return json(await serializeScripts(r.path));
      }
    }

    // GET /api/sessions/:sessionKey/scripts/:id/output
    {
      const m = method === "GET" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/([^/]+)\/output$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        const sp = getScript(m[2]);
        if (!sp || sp.projectPath !== r.path) {
          return json({ error: "Process not found in this project" }, 404);
        }
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        return json(outputPayload(sp, offset));
      }
    }

    // POST /api/sessions/:sessionKey/scripts/:id/stop
    {
      const m = method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/([^/]+)\/stop$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        const sp = runningScripts.get(m[2]);
        if (!sp || sp.projectPath !== r.path) {
          return json({ error: "Process not found in this project or already stopped" }, 404);
        }
        killRunningScript(sp);
        return json({ ok: true });
      }
    }

    return null;
  };
}
