import type { Server } from "bun";
import type { WSData } from "../types";

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
    target = { browserContextId };
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
