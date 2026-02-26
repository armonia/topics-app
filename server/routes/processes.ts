import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

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
        recentScripts.push({
          ...r,
          output: [],
          outputBytes: 0,
          proc: null,
        });
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
            output: ["[server restarted — previous output lost]"],
            outputBytes: 40,
            proc: null, // We don't have the handle, but we have the PID
          };
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
          addToRecent(sp);
        }
      }
    }
  } catch {}
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check
    return true;
  } catch {
    return false;
  }
}

function pollPidExit(sp: ScriptProcess) {
  const check = () => {
    if (!sp.pid || !isPidAlive(sp.pid)) {
      sp.status = "done";
      sp.completedAt = new Date().toISOString();
      sp.proc = null;
      runningScripts.delete(sp.processId);
      addToRecent(sp);
      saveState();
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
const PORT_CACHE_TTL = 3000;

async function getListeningPorts(): Promise<{ port: number; pid: number; command: string }[]> {
  const now = Date.now();
  if (now - cachedPortsAt < PORT_CACHE_TTL) return cachedPorts;

  try {
    const proc = Bun.spawn(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { stdout: "pipe", stderr: "pipe" });
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
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadState();

// ── Router ───────────────────────────────────────────────────────────────────

export function createProcessesRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

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

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(["npm", "run", scriptName], {
          cwd: projectPath,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FORCE_COLOR: "0" },
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

      // Stream stdout
      if (proc.stdout) {
        (async () => {
          const reader = proc.stdout!.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              appendOutput(sp, decoder.decode(value, { stream: true }));
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
              appendOutput(sp, decoder.decode(value, { stream: true }));
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

      return json({ scripts: [...runningList, ...recentList] });
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
      if (!pid) return json({ error: "No PID available" }, 500);

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
