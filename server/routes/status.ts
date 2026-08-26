import os from "os";
import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";
import { getListeningPorts, getTopCpuProcesses } from "./processes";
import { getFleetUsage } from "../lib/fleet-usage";
import { unknownPricedModels } from "../usage/pricing";
import { getProvider } from "../providers";
import { checkGatewayHealth as pingGateway } from "../providers/health";
import { detectAgents } from "../lib/detect-agents";
import { computePresenceCounts } from "../services/profile-stats";
import { countBusyAgentTerminals } from "./terminal";

const SERVER_START_TIME = Date.now();

// Live app version, read FRESH from the root package.json (mtime-cached so we
// don't re-parse on every poll). The client's baked `__APP_VERSION__` is
// frozen at `vite build --watch` start — after a version bump it lies until the
// build-watch is kickstarted. This endpoint is the runtime source of truth: the
// server process re-reads the file whenever it changes on disk, so the version
// chip reflects the current package.json the moment it's bumped.
const PKG_PATH = join(import.meta.dir, "..", "..", "package.json");
let _pkgCache: { mtimeMs: number; version: string } | null = null;

/**
 * The version BAKED at compile time, for the packaged build.
 *
 * `import.meta.dir` inside a `bun build --compile` binary points at a virtual
 * path, and next to it there is no `package.json` at all: on a machine where the
 * user simply INSTALLED Topics, the read below always threw and this endpoint
 * answered `0.0.0`. That is what the version chip in the sidebar showed —
 * reported 2026-08-26 on the Windows build, and it was never Windows-specific:
 * any installed build, on any system, read the same.
 *
 * The build script passes the real number in (`scripts/build-server-sidecar.sh`);
 * in a checkout the variable is absent and the file on disk stays the source of
 * truth, which is what dev wants — it re-reads on every bump without recompiling.
 */
const BAKED_VERSION = (process.env.TOPICS_APP_VERSION || "").trim();

function readAppVersion(): string {
  try {
    const mtimeMs = statSync(PKG_PATH).mtimeMs;
    if (_pkgCache && _pkgCache.mtimeMs === mtimeMs) return _pkgCache.version;
    const version = (JSON.parse(readFileSync(PKG_PATH, "utf8")).version as string) || "0.0.0";
    _pkgCache = { mtimeMs, version };
    return version;
  } catch {
    // The file is unreadable: in a packaged build it is not there at all. The
    // baked number is the answer, and `0.0.0` only when there is genuinely
    // nothing to say — never as the shrug it used to be.
    return _pkgCache?.version ?? (BAKED_VERSION || "0.0.0");
  }
}

type GatewayStatus = "online" | "offline" | "timeout" | "connection_refused" | "server_error" | "auth_error";

interface GatewayHealthResult {
  status: GatewayStatus;
  online: boolean;
  latencyMs: number;
  httpStatus?: number;
}

interface CronJobsStatus {
  enabled: number;
  disabled: number;
  total: number;
  nextRun?: string;
}

interface SessionsStatus {
  total: number;
  byType: Record<string, number>;
}

export function createStatusRouter(ctx: AppContext): RouteHandler {
  const { json, wsClients, activeStreams, db } = ctx;

  // Topic counts come straight from indexed COUNT(*) queries — this endpoint is
  // polled by the status bar, so it must not pay a full loadTopics() table-scan
  // + 5 relation joins just to report two numbers.
  const topicCountStmt = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN archived = 1 THEN 0 ELSE 1 END) AS active FROM topics`
  );

  // Cached state
  let lastGatewayCheck: (GatewayHealthResult & { checkedAt: string }) | null = null;
  let lastCronStatus: CronJobsStatus | null = null;
  let lastSessionsStatus: SessionsStatus | null = null;

  async function checkGatewayHealth(): Promise<GatewayHealthResult> {
    const provider = getProvider();

    // For non-OpenClaw providers, just check the connected flag
    if (provider.name !== "openclaw") {
      return {
        status: provider.connected ? "online" : "offline",
        online: provider.connected,
        latencyMs: 0,
      };
    }

    // OpenClaw: HTTP health check via shared helper
    const gatewayUrl = process.env.GATEWAY_URL;
    if (!gatewayUrl) {
      return { status: provider.connected ? "online" : "offline", online: provider.connected, latencyMs: 0 };
    }
    const result = await pingGateway(gatewayUrl, process.env.GATEWAY_TOKEN);
    return {
      status: result.status,
      online: result.online,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus,
    };
  }

  async function fetchCronStatus(): Promise<CronJobsStatus> {
    const provider = getProvider();
    if (!provider.invokeTool) {
      return { enabled: 0, disabled: 0, total: 0 };
    }
    try {
      const data = await provider.invokeTool("cron", { action: "list" }) as
        { result?: { jobs?: any[] }; jobs?: any[] } | undefined;
      const jobs = data?.result?.jobs || data?.jobs || [];
      let enabled = 0, disabled = 0;
      let nextRun: string | undefined;
      for (const job of jobs) {
        if (job.enabled || job.active) enabled++;
        else disabled++;
        if (job.nextRun && (!nextRun || job.nextRun < nextRun)) nextRun = job.nextRun;
      }
      return { enabled, disabled, total: jobs.length, nextRun };
    } catch {
      return { enabled: 0, disabled: 0, total: 0 };
    }
  }

  async function fetchSessionsStatus(): Promise<SessionsStatus> {
    const provider = getProvider();
    if (!provider.invokeTool) {
      return { total: 0, byType: {} };
    }
    try {
      const data = await provider.invokeTool("sessions_list", {}) as
        { result?: { sessions?: any[] }; sessions?: any[] } | undefined;
      const sessions = data?.result?.sessions || data?.sessions || [];
      const byType: Record<string, number> = {};
      for (const s of sessions) {
        const type = s.type || "unknown";
        byType[type] = (byType[type] || 0) + 1;
      }
      return { total: sessions.length, byType };
    } catch {
      return { total: 0, byType: {} };
    }
  }

  // Periodic background checks (every 30s)
  async function runBackgroundChecks() {
    try {
      // Cron/sessions polling only makes sense when the provider can invoke tools
      // (e.g. OpenClaw); skip it otherwise so we don't spin no-op async calls.
      const canInvokeTool = Boolean(getProvider().invokeTool);
      const [health, cron, sessions] = await Promise.all([
        checkGatewayHealth(),
        canInvokeTool ? fetchCronStatus() : Promise.resolve(lastCronStatus),
        canInvokeTool ? fetchSessionsStatus() : Promise.resolve(lastSessionsStatus),
      ]);
      lastGatewayCheck = { ...health, checkedAt: new Date().toISOString() };
      lastCronStatus = cron;
      lastSessionsStatus = sessions;
    } catch (err) {
      // Update checkedAt even on failure so the status bar shows freshness
      lastGatewayCheck = { status: "offline", online: false, latencyMs: 0, checkedAt: new Date().toISOString() };
    }
  }

  // Capture the interval id and unref it so the timer never keeps the
  // process alive on its own (avoids a leaked timer that polls forever,
  // including on non-OpenClaw setups).
  const backgroundCheckTimer = setInterval(runBackgroundChecks, 30000);
  if (typeof backgroundCheckTimer.unref === "function") backgroundCheckTimer.unref();
  runBackgroundChecks();

  return async function statusRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // Restart OpenClaw gateway (only supported for openclaw provider)
    if (method === "POST" && pathname === "/api/openclaw/restart") {
      const provider = getProvider();
      if (provider.name !== "openclaw") {
        return json({ ok: false, error: "Restart is only supported with the OpenClaw provider" }, 404);
      }
      try {
        const proc = Bun.spawn(["openclaw", "gateway", "restart"], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        // Reset cached gateway status so next poll picks up fresh state
        lastGatewayCheck = null;
        return json({ ok: exitCode === 0, output: stdout || stderr, exitCode });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // Runtime app version — read fresh from package.json (mtime-cached). The
    // version chip fetches this so a post-bump build no longer needs the
    // build-watch kickstart to stop showing the old number. no-store so no
    // layer (WKWebView HTTP cache included) serves a stale version.
    if (method === "GET" && pathname === "/api/version") {
      return new Response(JSON.stringify({ version: readAppVersion() }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    /**
     * IL RIEPILOGO, in quattro numeri e niente altro.
     *
     * Perché non è un campo di `/api/system/status`: quella rotta, per
     * rispondere, fa una scansione `ps` dell'intera flotta e interroga le porte
     * in ascolto, quindi la barra la interroga ogni 60 secondi. Un riepilogo
     * che dice «3 al lavoro» un minuto dopo che hanno finito non è un
     * riepilogo. Qui ci sono tre COUNT indicizzati e una lettura di due mappe
     * in memoria: si può chiedere ogni pochi secondi senza pagare niente.
     *
     * Sono gli STESSI numeri che finiscono sul profilo Discord (li calcola
     * `computePresenceCounts`, uno solo per entrambe le superfici): la barra
     * non stima per conto suo ciò che la presence sa.
     */
    if (method === "GET" && pathname === "/api/system/presence") {
      return json(computePresenceCounts(
        db,
        activeStreams.size + countBusyAgentTerminals(),
        ctx.externalSessionsCount?.() ?? 0,
        ctx.externalSessionsWorking?.() ?? 0,
      ));
    }

    /**
     * WHICH AGENTS ARE ACTUALLY INSTALLED on this machine.
     *
     * Topics runs the CLIs the user already has. Nothing asked this before
     * trying, so a missing agent produced a tab that opened and stayed empty —
     * on Windows without even a "command not found" to read, because the process
     * never started (reported 2026-08-26: "it opens Claude Code as a tab, but
     * nothing actually opens").
     *
     * Read-only and cheap: `Bun.which` plus a handful of `existsSync` on known
     * install locations. No spawn, no install, nothing touched.
     */
    if (method === "GET" && pathname === "/api/system/agents") {
      return json({ agents: detectAgents() });
    }

    if (method === "GET" && pathname === "/api/system/status") {
      const gateway = lastGatewayCheck || { status: "offline" as GatewayStatus, online: false, latencyMs: 0, checkedAt: null };

      const uptimeMs = Date.now() - SERVER_START_TIME;
      const memUsage = process.memoryUsage();

      // PC-level CPU pressure. loadavg() is the OS run-queue length averaged
      // over 1/5/15 min; dividing by core count gives a rough "how busy is the
      // whole machine" percent. This is the signal that distinguishes "the PC
      // is saturated (everything is slow)" from "Topics' renderer is the
      // bottleneck" (which the Electron per-process metrics answer instead).
      // On Windows loadavg() is always [0,0,0] — we surface that as null so the
      // client hides the row rather than showing a fake 0%.
      const cores = os.cpus().length || 1;
      const [load1, load5, load15] = os.loadavg();
      const loadSupported = load1 > 0 || load5 > 0 || load15 > 0;

      const topicCounts = topicCountStmt.get() as { total: number; active: number | null };
      const totalTopicsCount = topicCounts.total ?? 0;
      const activeTopicsCount = topicCounts.active ?? 0;

      const streamKeys = Array.from(activeStreams.keys());

      // Gather active ports + top CPU consumers (both reuse cached snapshots).
      let ports: { port: number; pid: number; command: string }[] = [];
      let topProcesses: { pid: number; cpu: number; command: string }[] = [];
      // Everything the SERVER side really costs: this process plus the detached
      // sidecars and their trees (the `claude` CLIs, MCP servers and headless
      // Chromes under the pty-bridge). `memoryMB` above is this process alone —
      // measured, ~87 MB against ~5 GB for the fleet it drives.
      let fleet: Awaited<ReturnType<typeof getFleetUsage>> | null = null;
      try {
        [ports, topProcesses, fleet] = await Promise.all([
          getListeningPorts(),
          getTopCpuProcesses(6),
          getFleetUsage(),
        ]);
      } catch {}

      return json({
        timestamp: new Date().toISOString(),
        gateway: {
          online: gateway.online,
          status: gateway.status,
          latencyMs: gateway.latencyMs,
          httpStatus: "httpStatus" in gateway ? gateway.httpStatus : undefined,
          lastCheckedAt: gateway.checkedAt,
        },
        server: {
          uptimeMs,
          startedAt: new Date(SERVER_START_TIME).toISOString(),
          // Use phys_footprint for the server process when fleet data is available
          // (fleet.roots contains a 'server' root measured with proc_pid_rusage).
          // Fall back to process.memoryUsage().rss only when fleet is absent.
          // This aligns the metric with the shell side (both use phys_footprint).
          memoryMB: fleet?.supported
            ? (fleet.roots.find(r => r.kind === "server")?.memoryMB ?? Math.round(memUsage.rss / 1024 / 1024))
            : Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
          // The whole server-side fleet (this process + sidecar trees), summed
          // using phys_footprint (same metric as the shell side). Absent where
          // ps is not usable (Windows). scriptsMB is the third axis: agent-
          // launched work excluded from the server total, shown separately.
          fleet: fleet && fleet.supported ? fleet : undefined,
          // Dev bundle hot-delivery is ON (topics-dev.json in STATE_DIR): open
          // windows self-reload on each rebuild. Drives the quiet "auto-update"
          // status-bar badge — works in the prod-minified bundle (unlike the
          // Vite-only `import.meta.env.DEV` badge). See startDevBundleReload.
          devReload: existsSync(join(ctx.STATE_DIR, "topics-dev.json")),
          // I modelli visti girare e NON presenti nella tabella prezzi. I loro
          // turni vengono contati a costo zero, che e' indistinguibile da «non
          // e' costato niente»: e' lo stesso guasto che teneva ogni Opus
          // tariffato al triplo senza che nessuno se ne accorgesse, e l'unico
          // modo perche' si veda e' che qualcosa lo DICA. Vuoto = tutto
          // tariffato.
          unpricedModels: unknownPricedModels(),
        },
        cpu: {
          cores,
          loadAvg1: Math.round(load1 * 100) / 100,
          loadAvg5: Math.round(load5 * 100) / 100,
          loadAvg15: Math.round(load15 * 100) / 100,
          loadPercent: loadSupported ? Math.round((load1 / cores) * 100) : null,
        },
        connections: {
          wsClients: wsClients.size,
          activeStreams: activeStreams.size,
          streamKeys,
        },
        topics: {
          activeCount: activeTopicsCount,
          totalCount: totalTopicsCount,
        },
        cronJobs: lastCronStatus || { enabled: 0, disabled: 0, total: 0 },
        sessions: lastSessionsStatus || { total: 0, byType: {} },
        ports,
        topProcesses,
      });
    }

    return null;
  };
}
