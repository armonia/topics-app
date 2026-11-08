/**
 * After a server restart, the viewer of a context the Mac's native pane hosted
 * waits for that host instead of starting Chromium (NATIVE-HOST-06).
 *
 * The iPad's socket comes back before the Mac's executor, which retries on a
 * 1-2-4-8-10 s ladder (nativeExecutorSocket.ts). Its first frames (`set_render`,
 * `resize`) and the 250 ms screencast start each launched a Chromium the host
 * then destroyed a few seconds later: 48 SIGTERMs in the production log of 14/10.
 *
 * Who knows the context was hosted is the viewer (its last `render_mode` said
 * so, `?host=native`), and only a process that never saw a host for it waits:
 * a host leaving a running server stays the fallback's business
 * (browser-host-mirror.ts). The wait holds the last frame of each kind and
 * replays it once, on the mirror if the host came back, on Chromium if not.
 */
import type { BrowserWsMessage } from "../shared/browser-ws-messages";

export const BOOT_HOST_WAIT_MS = 10_000;

export interface BootRaceSocket {
  readyState: number;
  data: object;
}

type HeldFrame = Extract<BrowserWsMessage, { type: "set_render" | "resize" | "nav" }>;

/** Buffers the viewer's Chromium-touching reconnect frames while its native host returns. */
export function createBrowserHostBootRace<T extends BootRaceSocket>(deps: {
  schedule?: (fn: () => void, ms: number) => () => void;
  hasSeenHost: (contextId: string) => boolean;
  isHosting: (contextId: string) => boolean;
  apply: (socket: T, contextId: string, frame: HeldFrame) => void;
}) {
  const schedule = deps.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  const waits = new Map<T, { contextId: string; cancel: () => void; frames: Map<HeldFrame["type"], HeldFrame>; onTimeout: (frames: HeldFrame[]) => void }>();

  const finish = (socket: T, timedOut = false): void => {
    const wait = waits.get(socket);
    if (!wait) return;
    waits.delete(socket);
    wait.cancel();
    if (socket.readyState !== 1) return;
    const frames = [...wait.frames.values()];
    for (const frame of frames) deps.apply(socket, wait.contextId, frame);
    if (timedOut) wait.onTimeout(frames);
  };

  return {
    begin(socket: T, contextId: string, enabled: boolean, onTimeout: (frames: HeldFrame[]) => void = () => {}): boolean {
      if (!enabled || deps.isHosting(contextId) || deps.hasSeenHost(contextId) || waits.has(socket)) return false;
      const wait = { contextId, cancel: () => {}, frames: new Map<HeldFrame["type"], HeldFrame>(), onTimeout };
      wait.cancel = schedule(() => finish(socket, true), BOOT_HOST_WAIT_MS);
      waits.set(socket, wait);
      return true;
    },
    isWaiting(socket: T): boolean { return waits.has(socket); },
    hold(socket: T, contextId: string, frame: BrowserWsMessage): boolean {
      const wait = waits.get(socket);
      if (!wait || wait.contextId !== contextId) return false;
      if (frame.type === "set_render" || frame.type === "resize" || (frame.type === "nav" && frame.phase === "request")) {
        wait.frames.set(frame.type, frame as HeldFrame);
        return true;
      }
      if (frame.type === "input" || frame.type === "focus_query") return true;
      return false;
    },
    hostReady(contextId: string): void {
      for (const [socket, wait] of waits) if (wait.contextId === contextId) finish(socket);
    },
    cancel(socket: T): void { const wait = waits.get(socket); if (wait) { waits.delete(socket); wait.cancel(); } },
  };
}
