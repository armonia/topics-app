/**
 * A WebSocket for the NODE side of a spec, on any Node the suite might run on.
 *
 * `WebSocket` became a global in Node 22. The machines that write these specs
 * run Node 25, so `new WebSocket(...)` in a spec's Node context works while you
 * are writing it; `.github/workflows/ci.yml` pins the runner to Node 20 (for
 * node-pty's native rebuild), where the same line is
 * `ReferenceError: WebSocket is not defined`.
 *
 * That is not a hypothetical. On 2026-08-15 it took `relay-reachability.spec.ts`
 * down nine times in one CI run, and `pane-server-migration.spec.ts` with it,
 * while both were green on every developer machine. It is the same shape as the
 * git-identity trap next door in `file-project.ts`: a spec that depends on how
 * the machine running it happens to be configured is a spec that can only fail
 * somewhere nobody is looking.
 *
 * So: prefer the platform's own, fall back to `ws` when it is absent. The
 * fallback is API-compatible for what specs use here (`addEventListener` for
 * open/error/message/close, `send`, `close`), which is why the call sites do not
 * change shape.
 *
 * This is for the NODE context only. Inside `page.evaluate` the browser has had
 * `WebSocket` forever and those call sites need nothing.
 */
import WsFallback from "ws";

/**
 * The surface the specs actually use, so neither implementation leaks into them.
 *
 * The listener argument is optional in the signature on purpose: half the call
 * sites want the event (`message`, and an `error` they log), half ignore it, and
 * a signature that forced one shape would make the other side of the suite
 * rewrite its callbacks for no gain.
 */
export interface NodeSocket {
  addEventListener(type: "open" | "close", listener: (e?: unknown) => void): void;
  addEventListener(type: "error", listener: (e?: unknown) => void): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onopen: ((e?: unknown) => void) | null;
  readyState: number;
  send(data: string): void;
  close(): void;
}

/**
 * True when this Node has the global. Exported so a spec can SAY which
 * implementation it measured with, rather than leaving a reader guessing why a
 * number differs between a laptop and CI.
 */
export const usesPlatformWebSocket = typeof globalThis.WebSocket === "function";

export function openSocket(url: string): NodeSocket {
  if (usesPlatformWebSocket) return new globalThis.WebSocket(url) as unknown as NodeSocket;
  // `ws` delivers `message` with a `data` property like the DOM event, so the
  // listener bodies in the specs are unchanged.
  return new WsFallback(url) as unknown as NodeSocket;
}

/**
 * The same choice, for a handshake that has to carry HEADERS.
 *
 * A spec that mounts server code in this Node process inherits that code's
 * runtime assumptions. `server/services/relay-client.ts` opens the socket
 * towards the tunnel listener with a bare `new WebSocket(url, { headers })`,
 * which is right where it runs — the server is Bun, and Bun's `WebSocket` is
 * the only one that takes headers, i.e. the only way the guest's cookie reaches
 * the handshake instead of being rewritten. Under Node 20 that same line throws
 * `ReferenceError`, the client catches it and answers the guest `502`, and a
 * relay spec fails saying "the upgrade must open" with no hint that the missing
 * piece is a global. That is what happened on 2026-08-15 to RELAY-E2E-03/08/09.
 *
 * So the seam the client already exposes (`apriSocketLocale`) gets an opener
 * that works on either Node: the platform's own where it exists — the same
 * object, built the same way, so a laptop keeps measuring the production path —
 * and `ws` where it does not, which is the one client on this side that takes
 * headers without a global.
 *
 * Returned as `unknown` on purpose: the caller casts it to whatever its own
 * seam declares, and neither implementation's type leaks in here.
 */
export function openSocketWithHeaders(
  url: string,
  o: { headers: Record<string, string>; protocols: string[] },
): unknown {
  if (usesPlatformWebSocket) {
    const opzioni: Record<string, unknown> = { headers: o.headers };
    if (o.protocols.length > 0) opzioni.protocols = o.protocols;
    // Same cast as the production opener, and for the same reason: the DOM type
    // wants subprotocols as the second argument, Bun/undici take an options bag.
    return new globalThis.WebSocket(url, opzioni as unknown as string[]);
  }
  return new WsFallback(url, o.protocols, { headers: o.headers });
}
