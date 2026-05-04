import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";
import { augmentEnv, wrapPty, stripAnsi } from "../utils/path-env";

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
    PERSIST_DIR = join(process.cwd(), ".state");
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
    running: Array.from(runningScripts.values()).map(sp => ({
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
    const proc = Bun.spawn(["/usr/sbin/lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { stdout: "pipe", stderr: "pipe" });
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

async function getDescendantPids(pid: number): Promise<Set<number>> {
  const result = new Set<number>([pid]);
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of output.trim().split("\n")) {
      const childPid = parseInt(line.trim(), 10);
      if (!isNaN(childPid) && !result.has(childPid)) {
        result.add(childPid);
        const grandchildren = await getDescendantPids(childPid);
        for (const gp of grandchildren) result.add(gp);
      }
    }
  } catch {}
  return result;
}

async function getPortsForProcess(pid: number): Promise<number[]> {
  const allPorts = await getListeningPorts();
  const treePids = await getDescendantPids(pid);
  return allPorts
    .filter(p => treePids.has(p.pid))
    .map(p => p.port);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function addToRecent(sp: ScriptProcess) {
  recentScripts.unshift(sp);
  if (recentScripts.length > MAX_RECENT) recentScripts.pop();
}

function appendOutput(sp: ScriptProcess, text: string) {
  if (!text) return;
  const lines = text.split("\n");
  for (const line of lines) {
    if (sp.outputBytes + line.length > MAX_OUTPUT_BYTES) {
      while (sp.output.length > 0 && sp.outputBytes + line.length > MAX_OUTPUT_BYTES) {
        const removed = sp.output.shift()!;
        sp.outputBytes -= removed.length;
      }
    }
    sp.output.push(line);
    sp.outputBytes += line.length;
  }
  // Persist to log file
  try {
    const logPath = join(getPersistDir(), "scripts", `${sp.processId}.log`);
    appendFileSync(logPath, text);
    // Rotation: if > 1MB, keep last 500KB
    try {
      const stat = statSync(logPath);
      if (stat.size > 1024 * 1024) {
        const content = readFileSync(logPath);
        writeFileSync(logPath, content.slice(content.length - 500 * 1024));
      }
    } catch {}
  } catch {}
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadState();
mkdirSync(join(getPersistDir(), "scripts"), { recursive: true });

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

export function createProcessesRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;
  _broadcastCtx = ctx; // store for pollPidExit callbacks

  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  return async function processesRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // POST /api/scripts/run — start a script
    if (method === "POST" && pathname === "/api/scripts/run") {
      const body = await readJSON(req);
      if (!body?.projectPath || !body?.scriptName) {
        return json({ error: "projectPath and scriptName required" }, 400);
      }

      const processId = crypto.randomUUID();
      const scriptName = body.scriptName as string;
      const projectPath = body.projectPath as string;
      const command = `npm run ${scriptName}`;

      // tty: true (default) wraps the command in script(1) so it gets a PTY.
      // Required by CLIs that check isatty() — supabase login, gh auth login,
      // npm login, etc. Set body.tty=false explicitly for legacy behavior.
      const useTty = body.tty !== false;
      const argv = useTty
        ? wrapPty(["npm", "run", scriptName])
        : ["npm", "run", scriptName];

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, {
          cwd: projectPath,
          stdout: "pipe",
          stderr: "pipe",
          // augmentEnv prepends ~/.bun/bin, /opt/homebrew/bin, etc. so scripts
          // that call `bun`, `pnpm`, `cargo`... resolve even when the server
          // is launched from launchd/tray with a minimal PATH.
          env: augmentEnv(process.env, {
            FORCE_COLOR: "0",
            NO_COLOR: "1",
            HOST: "0.0.0.0",
            NODE_ENV: "development",
            // npx prompts "Ok to proceed? (y)" before installing packages —
            // the Processes panel has no stdin to answer, so it would hang.
            // npm_config_yes=true makes npx proceed without asking. Same
            // effect as `npx --yes <pkg>`.
            //
            // We deliberately DON'T set CI=true: many dev servers
            // (create-react-app, etc.) change behavior under CI and would
            // exit immediately instead of running in watch mode.
            npm_config_yes: "true",
          }),
        });
      } catch (err: any) {
        return json({ error: `Failed to spawn: ${err.message}` }, 500);
      }

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

      // Stream stdout
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

      // Stream stderr
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

      // Handle process exit
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

      return json({
        processId,
        scriptName,
        pid: proc.pid,
        startedAt: sp.startedAt,
      });
    }

    // GET /api/scripts — list running + recent, with per-process ports
    if (method === "GET" && pathname === "/api/scripts") {
      // Server-side cache check (2s TTL)
      if (scriptsResponseCache && Date.now() - scriptsResponseCache.timestamp < SCRIPTS_CACHE_TTL) {
        return json(scriptsResponseCache.data);
      }
      // Resolve ports for each running script
      const runningList = await Promise.all(
        Array.from(runningScripts.values()).map(async sp => ({
          processId: sp.processId,
          scriptName: sp.scriptName,
          command: sp.command,
          projectPath: sp.projectPath,
          status: sp.status,
          pid: sp.pid,
          startedAt: sp.startedAt,
          completedAt: sp.completedAt,
          exitCode: sp.exitCode,
          ports: sp.pid ? await getPortsForProcess(sp.pid) : [],
        }))
      );

      const recentList = recentScripts.map(sp => ({
        processId: sp.processId,
        scriptName: sp.scriptName,
        command: sp.command,
        projectPath: sp.projectPath,
        status: sp.status,
        pid: sp.pid,
        startedAt: sp.startedAt,
        completedAt: sp.completedAt,
        exitCode: sp.exitCode,
        ports: [] as number[],
      }));

      const scriptsResult = { scripts: [...runningList, ...recentList] };
      scriptsResponseCache = { data: scriptsResult, timestamp: Date.now() };
      return json(scriptsResult);
    }

    // GET /api/scripts/:id/output — get process output (streaming with offset)
    const outputMatch = method === "GET" && pathname.match(/^\/api\/scripts\/([^/]+)\/output$/);
    if (outputMatch) {
      const processId = outputMatch[1];
      const sp = runningScripts.get(processId) || recentScripts.find(r => r.processId === processId);
      if (!sp) return json({ error: "Process not found" }, 404);

      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      const lines = sp.output.slice(offset);
      return json({
        output: lines.join("\n"),
        offset: sp.output.length,
        done: sp.status !== "running",
        status: sp.status,
        exitCode: sp.exitCode,
      });
    }

    // POST /api/scripts/:id/stop — kill a running process
    const stopMatch = method === "POST" && pathname.match(/^\/api\/scripts\/([^/]+)\/stop$/);
    if (stopMatch) {
      const processId = stopMatch[1];
      const sp = runningScripts.get(processId);
      if (!sp) return json({ error: "Process not found or already stopped" }, 404);

      // Kill by PID (works even for re-adopted processes without proc handle)
      const pid = sp.pid;
      if (!pid || !isPidAlive(pid)) {
        // PID missing or already dead/zombie — just clean up state
        sp.status = "error";
        sp.completedAt = new Date().toISOString();
        sp.exitCode = sp.exitCode ?? -1;
        sp.proc = null;
        runningScripts.delete(processId);
        addToRecent(sp);
        saveState();
        broadcastScriptsUpdate(ctx);
        return json({ ok: true });
      }

      try {
        // Kill entire process group
        process.kill(-pid, "SIGTERM");
      } catch {
        // Fallback: kill just the PID
        try { process.kill(pid, "SIGTERM"); } catch {}
      }

      // Force kill after 5s
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
      }, 5000);

      return json({ ok: true });
    }

    return null;
  };
}
