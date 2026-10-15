export const HOST_PING_INTERVAL_MS = 5_000;
export const HOST_PONG_TIMEOUT_MS = 15_000;

export interface NativeHostSocket {
  readyState: number;
  send(text: string): unknown;
}

/** Application-level liveness for registered executors; old clients stay on the protocol timeout. */
export function createNativeHostLiveness<T extends NativeHostSocket>(deps: {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  onLost: (contextId: string, socket: T) => void;
}) {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  const hosts = new Map<T, { contextId: string; lastPong: number; supported: boolean; cancelTimeout?: () => void }>();
  let cancel: (() => void) | null = null;

  const stopTimerIfIdle = () => {
    if (hosts.size || !cancel) return;
    cancel();
    cancel = null;
  };
  const arm = () => {
    if (cancel || hosts.size === 0) return;
    cancel = schedule(() => {
      cancel = null;
      for (const [socket] of hosts) {
        if (socket.readyState === 1) {
          try { socket.send(JSON.stringify({ type: "host_ping" })); } catch { /* timeout owns cleanup */ }
        }
      }
      stopTimerIfIdle();
      arm();
    }, HOST_PING_INTERVAL_MS);
  };

  return {
    register(contextId: string, socket: T): void {
      hosts.set(socket, { contextId, lastPong: now(), supported: false });
      arm();
    },
    pong(socket: T): boolean {
      const state = hosts.get(socket);
      if (!state) return false;
      state.lastPong = now();
      state.supported = true;
      state.cancelTimeout?.();
      state.cancelTimeout = schedule(() => {
        if (hosts.get(socket) !== state || now() - state.lastPong < HOST_PONG_TIMEOUT_MS) return;
        hosts.delete(socket);
        state.cancelTimeout = undefined;
        deps.onLost(state.contextId, socket);
        stopTimerIfIdle();
      }, HOST_PONG_TIMEOUT_MS);
      return true;
    },
    unregister(socket: T): void {
      const state = hosts.get(socket);
      state?.cancelTimeout?.();
      hosts.delete(socket);
      stopTimerIfIdle();
    },
    size(): number { return hosts.size; },
  };
}
