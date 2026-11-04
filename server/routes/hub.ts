/**
 * `/api/hub/*` and `/api/switchboard/*`: the bridge to the usage hub (:3360)
 * and to switchboard (:3335), the two always-on local services whose UI moves
 * into Topics (plan: ~/.claude/jarvis/docs/hub-in-topics.md, track 0).
 *
 *   /api/hub/<rest>?q          -> <hub>/api/<rest>?q
 *   /api/switchboard/<rest>?q  -> <switchboard>/api/<rest>?q
 *
 * Why a proxy and not a copy of the APIs: the hub stays up on its own
 * (delegate, the tray and the gates call it while Topics restarts), so the
 * truth lives there and Topics shows it. A copy would be a second place that
 * can be wrong.
 *
 * What the proxy does NOT let through:
 * - a path with `..`, `//` or characters outside the list: the destination is
 *   always the configured host, never a host spelled inside the path;
 * - the client's Origin, Cookie, Authorization: Topics already checked the
 *   device, and the hub refuses writes carrying a foreign Origin (right for a
 *   browser, wrong for us, a local client);
 * - a failure dressed as data: hub down is a 502 with the reason, never an
 *   empty 200 that a panel would read as "nothing to show".
 *
 * Guests never get here: `/api/hub` is not in `isGuestAllowedPath`'s allowlist.
 */
import type { AppContext, RouteHandler } from "../types";

export const HUB_DEFAULT_URL = "http://127.0.0.1:3360";
export const SWITCHBOARD_DEFAULT_URL = "http://127.0.0.1:3335";

/** Time allowed for the response headers. The body may last (switchboard's
 *  log SSE), so the timer stops as soon as the response starts. */
const HEADERS_TIMEOUT_MS = 10_000;

const SAFE_REST = /^[A-Za-z0-9._~\-/]*$/;

export interface HubBridgeDeps {
  fetchImpl?: typeof fetch;
  /** Read on every request; null means the service is not available here. */
  hubBase?: () => string | null;
  switchboardBase?: () => string | null;
  headersTimeoutMs?: number;
  /** The live reader (server/lib/hub-live.ts) behind `GET /api/hub-live`.
   *  `refresh` runs after a write that the hub accepted, so the change (a
   *  "waiting for you" item closed) reaches every window without waiting
   *  for the next tick. */
  live?: { snapshot(): Promise<unknown>; refresh?(): Promise<void> };
}

/**
 * Where a service lives. Under e2e (TOPICS_E2E=1) there is no default: a test
 * server talking to the real hub would write real "waiting for you" items.
 */
export function upstreamBase(envName: string, fallback: string, env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env[envName]?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return env.TOPICS_E2E === "1" ? null : fallback;
}

/** A valid `<rest>` or null. Empty is valid (`/api/hub/` -> `/api/`). */
export function safeRest(rest: string): string | null {
  if (!SAFE_REST.test(rest)) return null;
  if (rest.startsWith("/") || rest.includes("//")) return null;
  if (rest.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return rest;
}

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "last-event-id"];
// Not content-length / content-encoding: fetch hands back a DECODED body, so
// both would describe bytes that are no longer the ones being sent.
const FORWARDED_RESPONSE_HEADERS = ["content-type"];

export function createHubRouter(ctx: Pick<AppContext, "json">, deps: HubBridgeDeps = {}): RouteHandler {
  const { json } = ctx;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hubBase = deps.hubBase ?? (() => upstreamBase("TOPICS_HUB_URL", HUB_DEFAULT_URL));
  const swBase = deps.switchboardBase ?? (() => upstreamBase("TOPICS_SWITCHBOARD_URL", SWITCHBOARD_DEFAULT_URL));
  const headersTimeoutMs = deps.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;

  return async (req, url, pathname, method) => {
    // The first paint of a panel: what the WebSocket would have pushed so far.
    if (pathname === "/api/hub-live" && method === "GET") {
      if (!deps.live) return json({ error: "hub live data not available on this server" }, 503);
      return json(await deps.live.snapshot());
    }
    let upstream: "hub" | "switchboard";
    let rest: string;
    if (pathname.startsWith("/api/hub/")) { upstream = "hub"; rest = pathname.slice("/api/hub/".length); }
    else if (pathname.startsWith("/api/switchboard/")) { upstream = "switchboard"; rest = pathname.slice("/api/switchboard/".length); }
    else return null;

    const clean = safeRest(rest);
    if (clean === null) return json({ error: "invalid path", upstream }, 400);
    const base = upstream === "hub" ? hubBase() : swBase();
    if (!base) return json({ error: `${upstream} not available on this server`, upstream }, 503);

    const headers = new Headers();
    for (const h of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await req.arrayBuffer() : undefined;

    // One controller, aborted by the headers timeout or by the client leaving:
    // an SSE left open keeps the upstream request alive until someone closes it.
    const ac = new AbortController();
    const onClientGone = () => ac.abort();
    req.signal?.addEventListener("abort", onClientGone, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, headersTimeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(`${base}/api/${clean}${url.search}`, {
        method, headers, body, signal: ac.signal, redirect: "manual",
      });
    } catch (err) {
      req.signal?.removeEventListener("abort", onClientGone);
      const why = timedOut ? `timed out after ${headersTimeoutMs} ms` : (err instanceof Error ? err.message : String(err));
      return json({ error: `${upstream} not reachable at ${base}: ${why}`, upstream }, timedOut ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }

    // A redirect from the hub points at ITS host: following it in the browser
    // would leave Topics. Say what happened, without the Location.
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel();
      return json({ error: `${upstream} answered a redirect (${resp.status})`, upstream }, 502);
    }
    if (upstream === "hub" && hasBody && resp.ok) void deps.live?.refresh?.().catch(() => {});
    const out = new Headers({ "cache-control": "no-store" });
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = resp.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(resp.body, { status: resp.status, headers: out });
  };
}
