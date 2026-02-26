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

const MAX_OUTPUT_BYTES = 500 * 1024; // ~500KB per process
const MAX_RECENT = 10;

const runningScripts = new Map<string, ScriptProcess>();
const recentScripts: ScriptProcess[] = [];

function addToRecent(sp: ScriptProcess) {
  recentScripts.unshift(sp);
  if (recentScripts.length > MAX_RECENT) recentScripts.pop();
}

function appendOutput(sp: ScriptProcess, text: string) {
  if (!text) return;
  // Split into lines, add to buffer
  const lines = text.split("\n");
  for (const line of lines) {
    if (sp.outputBytes + line.length > MAX_OUTPUT_BYTES) {
      // Evict oldest lines until we have space
      while (sp.output.length > 0 && sp.outputBytes + line.length > MAX_OUTPUT_BYTES) {
        const removed = sp.output.shift()!;
        sp.outputBytes -= removed.length;
      }
    }
    sp.output.push(line);
    sp.outputBytes += line.length;
  }
}

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
      });

      return json({
        processId,
        scriptName,
        pid: proc.pid,
        startedAt: sp.startedAt,
      });
    }

    // GET /api/scripts — list running + recent
    if (method === "GET" && pathname === "/api/scripts") {
      const all = [
        ...Array.from(runningScripts.values()).map(sp => ({
          processId: sp.processId,
          scriptName: sp.scriptName,
          command: sp.command,
          projectPath: sp.projectPath,
          status: sp.status,
          pid: sp.pid,
          startedAt: sp.startedAt,
          completedAt: sp.completedAt,
          exitCode: sp.exitCode,
        })),
        ...recentScripts.map(sp => ({
          processId: sp.processId,
          scriptName: sp.scriptName,
          command: sp.command,
          projectPath: sp.projectPath,
          status: sp.status,
          pid: sp.pid,
          startedAt: sp.startedAt,
          completedAt: sp.completedAt,
          exitCode: sp.exitCode,
        })),
      ];
      return json({ scripts: all });
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
      if (!sp.proc) return json({ error: "Process handle lost" }, 500);

      try {
        sp.proc.kill("SIGTERM");
        // Force kill after 5s if still alive
        setTimeout(() => {
          if (sp.proc) {
            try { sp.proc.kill("SIGKILL"); } catch {}
          }
        }, 5000);
      } catch (err: any) {
        return json({ error: `Kill failed: ${err.message}` }, 500);
      }

      return json({ ok: true });
    }

    return null;
  };
}
