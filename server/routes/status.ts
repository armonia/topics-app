import type { AppContext, RouteHandler } from "../types";
import { getListeningPorts } from "./processes";
import { getProvider } from "../providers";
import { checkGatewayHealth as pingGateway } from "../providers/health";

const SERVER_START_TIME = Date.now();

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
  const { json, wsClients, activeStreams, loadTopics } = ctx;

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

    if (method === "GET" && pathname === "/api/system/status") {
      const gateway = lastGatewayCheck || { status: "offline" as GatewayStatus, online: false, latencyMs: 0, checkedAt: null };

      const uptimeMs = Date.now() - SERVER_START_TIME;
      const memUsage = process.memoryUsage();

      const topicsData = loadTopics();
      const activeTopicsCount = Object.values(topicsData.topics).filter(t => !t.archived).length;

      const streamKeys = Array.from(activeStreams.keys());

      // Gather active ports (reuse cached lsof from processes.ts)
      let ports: { port: number; pid: number; command: string }[] = [];
      try {
        ports = await getListeningPorts();
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
          memoryMB: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        connections: {
          wsClients: wsClients.size,
          activeStreams: activeStreams.size,
          streamKeys,
        },
        topics: {
          activeCount: activeTopicsCount,
          totalCount: Object.keys(topicsData.topics).length,
        },
        cronJobs: lastCronStatus || { enabled: 0, disabled: 0, total: 0 },
        sessions: lastSessionsStatus || { total: 0, byType: {} },
        ports,
      });
    }

    return null;
  };
}
