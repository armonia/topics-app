import type { AppContext, RouteHandler } from "../types";
import { runBounded, SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { withoutGatewayToken } from "../lib/openclaw-gateway-token";
import { augmentPath } from "../utils/path-env";

export type GatewayCallResult =
  | { ok: true; payload: any }
  | { ok: false; status: number; message: string };

export type GatewayCall = (method: string, params: Record<string, unknown>) => Promise<GatewayCallResult>;

/**
 * One gateway RPC through the OpenClaw CLI (`openclaw gateway call`).
 *
 * Not `POST /tools/invoke`: OpenClaw denies the scheduler tool on that HTTP
 * surface by default (`DEFAULT_GATEWAY_HTTP_TOOL_DENY` lists `automations`, and
 * `cron` is its alias), so every call answered 404 "Tool not available". Not
 * Topics' own WebSocket client either: it exists only with the OpenClaw
 * provider and speaks a protocol version the gateway may have moved past. The
 * CLI ships with the gateway, resolves the gateway token itself (Keychain
 * SecretRef included) and talks to the gateway its own config points at, so no
 * token passes through Topics and nothing leaks into argv.
 *
 * Failure shape, measured on 2026.10.5: exit 1 and `{ok:false, error:{code,
 * message}}` on stdout. `INVALID_REQUEST` (unknown job id, bad patch) maps to
 * 400; anything else is the gateway being unreachable or broken, 502.
 */
export async function openclawGatewayCall(
  method: string,
  params: Record<string, unknown>,
  bin: string | null = Bun.which("openclaw", { PATH: augmentPath() }),
): Promise<GatewayCallResult> {
  if (!bin) return { ok: false, status: 502, message: "openclaw CLI not found on PATH" };
  const r = await runBounded([bin, "gateway", "call", method, "--params", JSON.stringify(params), "--json"], {
    env: { ...withoutGatewayToken(), PATH: augmentPath() },
    stderr: "pipe",
    timeoutMs: SPAWN_TIMEOUT.query,
  });
  if (r.spawnFailed) return { ok: false, status: 502, message: `openclaw did not start: ${r.spawnError ?? "unknown error"}` };
  if (r.timedOut) return { ok: false, status: 502, message: `openclaw gateway call ${method} timed out` };
  let out: any;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  if (r.exitCode === 0 && out !== undefined) return { ok: true, payload: out };
  const error = out?.error;
  if (typeof error?.message === "string") {
    return { ok: false, status: error.code === "INVALID_REQUEST" ? 400 : 502, message: error.message };
  }
  const tail = (r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.exitCode}`;
  return { ok: false, status: 502, message: `openclaw gateway call ${method} failed: ${tail}` };
}

export function createCronRouter(ctx: AppContext, call: GatewayCall = openclawGatewayCall): RouteHandler {
  const { readJSON, json, matchRoute, broadcastToAll } = ctx;

  // Re-fetch the cron job list and broadcast it to all clients (best-effort).
  async function broadcastCronList() {
    const r = await call("cron.list", { includeDisabled: true });
    if (r.ok) broadcastToAll({ type: "cron:updated", jobs: r.payload?.jobs ?? [] });
  }

  return async function cronRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {

    if (method === "GET" && pathname === "/api/cron/jobs") {
      const r = await call("cron.list", { includeDisabled: true });
      // 502, not 200 with an empty list: the panel reads `res.ok`, and a
      // gateway that is down must not look like every job was deleted.
      if (!r.ok) return json({ jobs: [], warning: `Gateway error: ${r.message}` }, 502);
      return json({ jobs: r.payload?.jobs ?? [] });
    }

    const cronJobMatch = matchRoute(pathname, "/api/cron/jobs/:jobId");
    if (cronJobMatch && method === "PATCH") {
      const patch = await readJSON(req);
      const r = await call("cron.update", { id: cronJobMatch.jobId, patch });
      if (!r.ok) return json({ error: `Gateway error: ${r.message}` }, r.status);
      await broadcastCronList();
      return json({ ok: true });
    }

    const cronRunMatch = matchRoute(pathname, "/api/cron/jobs/:jobId/run");
    if (cronRunMatch && method === "POST") {
      // "force", as `openclaw cron run`: the button means run now, due or not.
      const r = await call("cron.run", { id: cronRunMatch.jobId, mode: "force" });
      if (!r.ok) return json({ error: `Gateway error: ${r.message}` }, r.status);
      await broadcastCronList();
      return json({ ok: true });
    }

    if (cronJobMatch && method === "DELETE") {
      const r = await call("cron.remove", { id: cronJobMatch.jobId });
      if (!r.ok) return json({ error: `Gateway error: ${r.message}` }, r.status);
      await broadcastCronList();
      return json({ ok: true });
    }

    return null;
  };
}
