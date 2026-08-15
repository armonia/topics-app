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
