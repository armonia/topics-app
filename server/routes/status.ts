import type { AppContext, RouteHandler } from "../types";
import { getListeningPorts } from "./processes";

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
  const { GATEWAY_URL, GATEWAY_TOKEN, json, wsClients, activeStreams, loadTopics } = ctx;

  // Cached state
  let lastGatewayCheck: (GatewayHealthResult & { checkedAt: string }) | null = null;
  let lastCronStatus: CronJobsStatus | null = null;
  let lastSessionsStatus: SessionsStatus | null = null;

  async function gatewayFetch(tool: string, args: object = {}): Promise<Response> {
    return fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(5000),
    });
  }

  async function checkGatewayHealth(): Promise<GatewayHealthResult> {
    const start = Date.now();
    try {
      const resp = await gatewayFetch("session_status");
      const latencyMs = Date.now() - start;
      if (resp.ok) return { status: "online", online: true, latencyMs, httpStatus: resp.status };
      if (resp.status === 401 || resp.status === 403) return { status: "auth_error", online: false, latencyMs, httpStatus: resp.status };
      if (resp.status >= 500) return { status: "server_error", online: false, latencyMs, httpStatus: resp.status };
      return { status: "offline", online: false, latencyMs, httpStatus: resp.status };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      if (err?.name === "AbortError" || err?.name === "TimeoutError") return { status: "timeout", online: false, latencyMs };
      if (err?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED")) return { status: "connection_refused", online: false, latencyMs };
      return { status: "offline", online: false, latencyMs };
    }
  }

  async function fetchCronStatus(): Promise<CronJobsStatus> {
    try {
      const resp = await gatewayFetch("cron", { action: "list" });
      if (!resp.ok) return { enabled: 0, disabled: 0, total: 0 };
      const data = await resp.json();
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
    try {
      const resp = await gatewayFetch("sessions_list");
      if (!resp.ok) return { total: 0, byType: {} };
      const data = await resp.json();
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
      const [health, cron, sessions] = await Promise.all([
        checkGatewayHealth(),
        fetchCronStatus(),
        fetchSessionsStatus(),
      ]);
      lastGatewayCheck = { ...health, checkedAt: new Date().toISOString() };
      lastCronStatus = cron;
      lastSessionsStatus = sessions;
    } catch (err) {
      // Update checkedAt even on failure so the status bar shows freshness
      lastGatewayCheck = { status: "offline", online: false, latencyMs: 0, checkedAt: new Date().toISOString() };
    }
  }

  setInterval(runBackgroundChecks, 30000);
  runBackgroundChecks();

  return async function statusRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // Restart OpenClaw gateway
    if (method === "POST" && pathname === "/api/openclaw/restart") {
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
          httpStatus: gateway.httpStatus,
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
