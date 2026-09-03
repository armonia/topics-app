/**
 * THE SOCKET THAT MAKES A NATIVE BROWSER PANE DRIVABLE, AND THAT COMES BACK.
 *
 * A native pane (Tauri/WKWebView) is not streamed: the server does not act on
 * it, it DELEGATES. The pane opens `/ws/browser/:contextId`, says
 * `register_native_executor`, and from then on every agent tool-call arrives as
 * a `browser_op` frame that this pane runs against the real webview and answers
 * with a `browser_op_result`. That socket IS the delegation: no socket, no
 * agent control.
 *
 * WHAT WAS MISSING. The socket was opened once, in a mount effect, and never
 * reopened. It dies often and for ordinary reasons: the server restarts (the
 * file watcher sends SIGTERM on every save under `server/`, many times a day),
 * the machine sleeps, the network blinks. After that the pane stayed mounted
 * and looked fine, but no tool-call could reach it any more - the only cure was
 * closing and reopening the pane, and nothing said so. The pill stopping (see
 * `agentActivity.ts`) told the truth about the socket; it did not bring it back.
 *
 * The streaming sibling already had the exit: the reconnect backoff in
 * `useRemoteBrowser.ts`. This module is that exit for the native pane, kept out
 * of the hook so it can be driven - and falsified - without a browser: the
 * socket and the clock are injected.
 *
 * WHY A SEPARATE MODULE AND NOT AN EFFECT. Inside `useEffect` the reconnection
 * can only be tested by unmounting and remounting the pane, which proves the
 * mount path and hides exactly this defect: a test that reopens the pane always
 * passed, before and after the fix.
 */
import { nextAgentActive } from './agentActivity';
import { parseBrowserWsMessage } from '../../../shared/browser-ws-messages';

/** First retry after 1s, doubling, never slower than this (same ceiling as the streaming pane). */
const MAX_RECONNECT_DELAY_MS = 10000;

/**
 * How long to wait before retry number `attempt` (0-based).
 *
 * Pure so it can fail in a test: exponential up to a ceiling, so a server that
 * is down for an hour is polled every 10s instead of every 10 minutes - a
 * native pane that reconnects "eventually" is a pane the agent cannot drive.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), MAX_RECONNECT_DELAY_MS);
}

/**
 * What a delegated tool-call answers with: a result, or the reason it failed.
 * Same shape `executeNativeBrowserOp` returns, restated here so this module
 * does not depend on the native ops it merely carries.
 */
export interface DelegatedOpOutcome {
  result?: unknown;
  error?: string;
}

/** The little of a WebSocket this module uses. */
export interface ExecutorSocket {
  send(text: string): void;
  close(): void;
}

/** What the supervisor wants to hear from a socket. `onDead` covers close AND error. */
export interface ExecutorSocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onDead(): void;
}

export type ExecutorSocketFactory = (url: string, handlers: ExecutorSocketHandlers) => ExecutorSocket;

/** Run `fn` after `ms`; returns the cancel. Injectable so a test owns the clock. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export interface NativeExecutorSocketOptions {
  /** `ws://host/ws/browser/:contextId`. */
  url: string;
  /** Execute one delegated tool-call against the real pane; resolves the reply payload. */
  runOp: (tool: string, args: unknown) => Promise<DelegatedOpOutcome>;
  /** The pill: true/false from the server, and false whenever the socket dies. */
  onAgentActive: (active: boolean, action?: string) => void;
  /** The pushed viewer count of the context (`viewers` frame): the auto-share
   *  decision reads it from here instead of polling the route every 2s. */
  onViewers?: (count: number) => void;
  /** The socket is up (true) or gone (false): while up, a change in the count
   *  is pushed through it and the fallback poll can sleep. */
  onChannel?: (up: boolean) => void;
  createSocket?: ExecutorSocketFactory;
  schedule?: Schedule;
}

export interface NativeExecutorSocketRun {
  /** Stop for good: no further reconnect, current socket closed. */
  stop(): void;
}

/** Default factory: a real WebSocket, with the DOM plumbing kept in one place. */
export const webSocketFactory: ExecutorSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => handlers.onOpen());
  ws.addEventListener('message', (e: MessageEvent) => handlers.onMessage(e.data));
  ws.addEventListener('close', () => handlers.onDead());
  ws.addEventListener('error', () => handlers.onDead());
  return {
    send: (text: string) => { try { ws.send(text); } catch { /* the dead-handler will reconnect */ } },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
  };
};

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * Keep this pane registered as the executor of its context, across restarts.
 *
 * One call per mounted pane. The pane does NOT remount to reconnect: a dead
 * socket is replaced in place, re-registers, and the next delegated tool-call
 * runs as if nothing had happened.
 */
export function startNativeExecutorSocket(opts: NativeExecutorSocketOptions): NativeExecutorSocketRun {
  const createSocket = opts.createSocket ?? webSocketFactory;
  const schedule = opts.schedule ?? defaultSchedule;

  let stopped = false;
  let socket: ExecutorSocket | null = null;
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;

  /** Reply/send only on the socket that is current NOW: a dead one has nowhere to put it. */
  const sendOn = (target: ExecutorSocket, payload: unknown): void => {
    if (stopped || socket !== target) return;
    target.send(JSON.stringify(payload));
  };

  const connect = (): void => {
    if (stopped) return;
    cancelRetry = null;
    let self: ExecutorSocket | null = null;
    const handlers: ExecutorSocketHandlers = {
      onOpen: () => {
        if (!self) return;
        // A fresh server has an empty registry, so re-registering is what makes
        // the pane reachable again. On a server that never went down it is
        // accepted too: the old socket is closed, so this is a reconnection and
        // not a hijack (server.ts checks the previous owner's liveness).
        attempt = 0;
        sendOn(self, { type: 'register_native_executor' });
        opts.onChannel?.(true);
      },
      onMessage: (data) => { if (self) handleFrame(self, data); },
      onDead: () => {
        if (stopped || socket !== self) return;
        socket = null;
        opts.onChannel?.(false);
        // A socket that died is not reporting anything (BROWSER-AGENT-PILL-01).
        opts.onAgentActive(nextAgentActive({ kind: 'disconnected' }));
        if (cancelRetry) cancelRetry();
        const delay = reconnectDelayMs(attempt);
        attempt += 1;
        cancelRetry = schedule(connect, delay);
      },
    };
    try {
      self = createSocket(opts.url, handlers);
      socket = self;
    } catch {
      // Construction itself failed (no server at all yet): retry on the same ladder.
      const delay = reconnectDelayMs(attempt);
      attempt += 1;
      cancelRetry = schedule(connect, delay);
    }
  };

  const standDown = (): void => {
    // The server answered that a LIVE executor already serves this context and
    // closed us: we are the second pane. Knocking again on a ladder would be a
    // hijack loop, so this one stops for good.
    stopped = true;
    if (cancelRetry) cancelRetry();
    cancelRetry = null;
    socket = null;
  };

  const handleFrame = (self: ExecutorSocket, data: unknown): void => {
    let raw: unknown;
    try { raw = JSON.parse(typeof data === 'string' ? data : ''); } catch { return; }
    const m = raw as { type?: string; opId?: string; tool?: string; args?: unknown };
    if (m && m.type === 'register_native_executor_rejected') {
      standDown();
      return;
    }
    if (m && m.type === 'browser_op' && typeof m.opId === 'string' && typeof m.tool === 'string') {
      const opId = m.opId;
      void opts.runOp(m.tool, m.args)
        .then((out) => { sendOn(self, { type: 'browser_op_result', opId, ...out }); })
        .catch((err: unknown) => {
          sendOn(self, { type: 'browser_op_result', opId, error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    const parsed = parseBrowserWsMessage(raw);
    if (!parsed.ok) return;
    if (parsed.data.type === 'viewers') {
      opts.onViewers?.(parsed.data.count);
      return;
    }
    if (parsed.data.type !== 'agent_active') return;
    opts.onAgentActive(nextAgentActive({ kind: 'frame', active: Boolean(parsed.data.active) }), parsed.data.action);
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (cancelRetry) cancelRetry();
      cancelRetry = null;
      const open = socket;
      socket = null;
      // `onDead` is inert once stopped: the withdrawal happens here instead.
      if (open) opts.onChannel?.(false);
      open?.close();
    },
  };
}
