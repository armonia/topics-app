import type { Server } from "bun";
import type { WSData } from "../types";

/** How much of a `?client=` we keep: enough for a uuid, not enough to be a payload. */
const CLIENT_ID_MAX = 64;

/**
 * The pane's own name for itself, from `?client=`.
 *
 * The viewport arbiter needs to recognise a client that comes back on a new
 * socket (see client/src/lib/browserClientId.ts). It is not an identity and it
 * is never trusted as one: whoever reads it namespaces it under the
 * authenticated device. Kept to a safe alphabet so it can be put in a log line
 * or a map key without thinking about it twice.
 */
function paneClientId(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get("client");
  if (!raw) return null;
  const clean = raw.slice(0, CLIENT_ID_MAX);
  return /^[A-Za-z0-9_-]+$/.test(clean) ? clean : null;
}

/** null means this is not a WebSocket route; undefined means upgraded. */
export function upgradeWebSocket(
  req: Request,
  pathname: string,
  server: Pick<Server<WSData>, "upgrade">,
  identity: { deviceId: string | null; role: "owner" | "guest" } | null,
  remote: boolean,
): Response | null | undefined {
  let target: Partial<WSData>;
  if (pathname.startsWith("/ws/terminal/")) {
    target = { terminalId: pathname.slice("/ws/terminal/".length) };
  } else if (pathname.startsWith("/ws/browser/")) {
    const browserContextId = decodeURIComponent(pathname.slice("/ws/browser/".length));
    if (!browserContextId) return new Response("Missing contextId", { status: 400 });
    target = { browserContextId, clientId: paneClientId(req) };
  } else if (pathname === "/ws") {
    target = {};
  } else {
    return null;
  }
  const data: WSData = {
    id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), remote,
    deviceId: identity?.deviceId ?? null, deviceRole: identity?.deviceId ? identity.role : null, ...target,
  };
  if (server.upgrade(req, { data })) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}
