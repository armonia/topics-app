/**
 * `GET /api/machines/overview` and `PUT /api/machines/providers/:id/token`.
 *
 * One row per machine Topics knows (this one, paired nodes, a permanent cloud
 * node), with the same gauges and a short history, so the tray and the
 * Processes view draw a node exactly like this computer. A machine a provider
 * adapter recognises also carries the provider's facts (cost, location, type).
 *
 * The history is kept in memory, one sample per read at most every
 * `SAMPLE_GAP_MS`: it is the shape of the last hours since the server started,
 * not a stored series.
 */
import os from "node:os";
import type { AppContext, RouteHandler } from "../types";
import type { MachineMetrics, MachineOverview, MachineOverviewRow, MachineSample } from "../../shared/machine-overview";
import { readLocalMetrics } from "../lib/machine-metrics";
import { NODE_SESSION_COOKIE, readNodeToken } from "../services/node-client";
import { isCloudBaseUrl } from "../providers/claude-cloud/node";
import { createProviderRegistry, matchServer, writeProviderToken, type ProviderRegistry } from "../services/machine-providers";

const REMOTE_TIMEOUT_MS = 5_000;
const SAMPLE_GAP_MS = 30_000;
const MAX_SAMPLES = 720;
/** A node's answer is reused this long so several windows polling do not become several calls to the node. */
const REMOTE_TTL_MS = 10_000;

type Remote = { metrics: MachineMetrics | null; reason: string | null };

export function createMachinesOverviewRoute(ctx: AppContext, opts: { registry?: ProviderRegistry; fetchImpl?: typeof fetch; now?: () => number } = {}): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, machineStore } = ctx;
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const registry = opts.registry ?? createProviderRegistry({ stateDir: ctx.STATE_DIR, fetchImpl });
  const history = new Map<string, MachineSample[]>();
  const remoteCache = new Map<string, { at: number; value: Remote }>();

  async function readRemote(id: string, baseUrl: string): Promise<Remote> {
    const hit = remoteCache.get(id);
    if (hit && now() - hit.at < REMOTE_TTL_MS) return hit.value;
    const token = readNodeToken(ctx.STATE_DIR, id);
    let value: Remote;
    if (!token) value = { metrics: null, reason: "not_paired" };
    else {
      try {
        const res = await fetchImpl(`${baseUrl}/api/system/machine-metrics`, {
          headers: { Accept: "application/json", Cookie: `${NODE_SESSION_COOKIE}=${token}` },
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        if (!res.ok) value = { metrics: null, reason: `http_${res.status}` };
        else {
          const body = (await res.json()) as { metrics?: MachineMetrics };
          value = body.metrics ? { metrics: body.metrics, reason: null } : { metrics: null, reason: "empty" };
        }
      } catch {
        value = { metrics: null, reason: "unreachable" };
      }
    }
    remoteCache.set(id, { at: now(), value });
    return value;
  }

  function record(id: string, m: MachineMetrics | null): MachineSample[] {
    const list = history.get(id) ?? [];
    const t = now();
    if (m && (list.length === 0 || t - list[list.length - 1].t >= SAMPLE_GAP_MS)) {
      list.push({ t, cpu: m.cpuPct, mem: m.memPct, disk: m.diskPct });
      if (list.length > MAX_SAMPLES) list.shift();
      history.set(id, list);
    }
    return list;
  }

  async function overview(): Promise<MachineOverview> {
    const local = (() => { try { return machineStore.upsertLocal(); } catch { return null; } })();
    const { servers, errors } = await registry.servers();
    const rows = await Promise.all(machineStore.list().map(async (m): Promise<MachineOverviewRow> => {
      const isLocal = m.id === local?.id;
      let metrics: MachineMetrics | null = null;
      let reason: string | null = null;
      if (isLocal) metrics = readLocalMetrics(now());
      else if (!m.baseUrl || isCloudBaseUrl(m.baseUrl)) reason = "not_a_node";
      else ({ metrics, reason } = await readRemote(m.id, m.baseUrl));

      const server = isLocal ? null : matchServer(servers, m);
      // The provider's own word wins over a silent node: a machine it says is powered off is stopped, not broken.
      const stopped = server?.status === "off";
      const adapterId = server?.adapterId ?? null;
      return {
        id: m.id,
        name: m.name,
        local: isLocal,
        platform: m.platform || (isLocal ? process.platform : ""),
        state: metrics ? "live" : stopped ? "stopped" : "unreachable",
        reason: metrics ? null : stopped ? "powered_off" : reason,
        metrics,
        history: record(m.id, metrics),
        provider: server?.facts ?? null,
        providerError: !server && Object.keys(errors).length > 0 && !isLocal ? Object.values(errors)[0] : adapterId && errors[adapterId] ? errors[adapterId] : null,
        at: now(),
      };
    }));
    return {
      machines: rows,
      providers: registry.adapters().map((a) => ({ id: a.id, label: a.label, configured: registry.configured(a.id) })),
    };
  }

  return async function machinesOverviewRouter(req, _url, pathname, method) {
    if (method === "GET" && pathname === "/api/machines/overview") return json(await overview());
    if (method === "GET" && pathname === "/api/system/machine-metrics") {
      return json({ metrics: readLocalMetrics(now()), hostname: os.hostname() });
    }
    const tokenRoute = matchRoute(pathname, "/api/machines/providers/:id/token");
    if (tokenRoute && method === "PUT") {
      if (!registry.adapters().some((a) => a.id === tokenRoute.id)) return errorResponse(404, "unknown provider");
      const body = await readJSON(req);
      if (!body || (body.token !== null && typeof body.token !== "string")) return errorResponse(400, "token must be a string or null");
      if (!writeProviderToken(ctx.STATE_DIR, tokenRoute.id, body.token as string | null)) return errorResponse(400, "that does not look like an API token");
      return json({ ok: true, configured: registry.configured(tokenRoute.id) });
    }
    return null;
  };
}
