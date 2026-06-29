/**
 * Native-pane agent delegation transport (Tauri).
 *
 * On Electron the server drives the browser pane directly via CDP; on Tauri the
 * pane is a native WKWebView the server can't reach (no CDP endpoint). This module
 * is the seam that lets a Tauri client register itself as the EXECUTOR for its own
 * pane's contextId, so the agent's browser tool-calls are forwarded to that client
 * over the existing /ws/browser/:contextId socket and run there via the native
 * `browser_*` Tauri commands, with the result piped back.
 *
 * Pure + transport-agnostic: the WS `send` is injected at register time and the
 * inbound results are fed in via `resolveOp`, so the protocol logic is unit-tested
 * without any live socket. The `nowMs`/`setTimer` seam keeps the timeout testable.
 */

export interface BrowserOpMessage {
  type: 'browser_op';
  opId: string;
  tool: string;
  args: unknown;
}

export interface BrowserOpResult {
  opId: string;
  result?: unknown;
  error?: string;
}

type SendFn = (msg: BrowserOpMessage) => void;

interface Pending {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface NativeDelegateRegistry {
  /** Mark a contextId as client-executed and store its outbound `send`. */
  register(contextId: string, send: SendFn): void;
  /** Drop a contextId (client disconnected / pane closed). Rejects its in-flight ops. */
  unregister(contextId: string): void;
  /** Is this contextId currently client-delegated (a live native pane)? */
  isDelegated(contextId: string): boolean;
  /** Forward a tool-call to the client and await its reply (or a timeout error). */
  delegateOp(contextId: string, tool: string, args: unknown): Promise<unknown>;
  /** Feed an inbound `browser_op_result` from the client; resolves the pending op. */
  resolveOp(res: BrowserOpResult): void;
  /** Count of registered contexts (introspection / tests). */
  size(): number;
}

export interface CreateRegistryOpts {
  /** Op timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Injectable id generator so tests are deterministic (default: counter). */
  genOpId?: () => string;
}

export function createNativeDelegateRegistry(opts: CreateRegistryOpts = {}): NativeDelegateRegistry {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let counter = 0;
  const genOpId = opts.genOpId ?? (() => `op-${++counter}`);

  const senders = new Map<string, SendFn>();
  // opId → pending resolver. We resolve (never reject) with an {error} object so a
  // timeout/disconnect surfaces to the agent as a structured tool error, matching
  // how the CDP/Playwright handlers report failures.
  const pending = new Map<string, Pending>();

  function settle(opId: string, value: unknown): void {
    const p = pending.get(opId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(opId);
    p.resolve(value);
  }

  return {
    register(contextId, send) {
      senders.set(contextId, send);
    },
    unregister(contextId) {
      senders.delete(contextId);
      // Fail any in-flight ops that were destined for this client.
      for (const [opId, p] of pending) {
        if (opId.startsWith(`${contextId}::`)) {
          clearTimeout(p.timer);
          pending.delete(opId);
          p.resolve({ error: 'native browser pane disconnected' });
        }
      }
    },
    isDelegated(contextId) {
      return senders.has(contextId);
    },
    delegateOp(contextId, tool, args) {
      const send = senders.get(contextId);
      if (!send) return Promise.resolve({ error: 'no native executor for context' });
      // Namespace the opId with the contextId so unregister can fail just its ops.
      const opId = `${contextId}::${genOpId()}`;
      return new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.has(opId)) {
            pending.delete(opId);
            resolve({ error: `native browser op '${tool}' timed out` });
          }
        }, timeoutMs);
        pending.set(opId, { resolve, timer });
        try {
          send({ type: 'browser_op', opId, tool, args });
        } catch {
          settle(opId, { error: 'failed to send op to native pane' });
        }
      });
    },
    resolveOp(res) {
      if (!res || typeof res.opId !== 'string') return;
      settle(res.opId, res.error !== undefined ? { error: res.error } : res.result);
    },
    size() {
      return senders.size;
    },
  };
}

/** Process-wide singleton used by the live server (routes wire register/resolve,
 *  the dispatcher calls isDelegated/delegateOp). Tests use createNativeDelegateRegistry. */
export const nativeDelegateRegistry = createNativeDelegateRegistry();

/**
 * Server /ws/browser inbound classifier for the two delegation frames. Extracted
 * from server.ts so the REAL handler logic is unit-tested without booting the
 * server: `register_native_executor` registers this socket's `send`,
 * `browser_op_result` resolves the pending op. Returns what it did (or null if the
 * frame isn't ours — the caller then falls through to the streaming Zod parse).
 * The caller still owns socket-specific side-effects (e.g. tearing down the
 * screencast on 'registered').
 */
export function handleNativeDelegationFrame(
  raw: unknown,
  contextId: string,
  send: SendFn,
  registry: NativeDelegateRegistry,
): 'registered' | 'result' | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { type?: string; opId?: string; result?: unknown; error?: string };
  if (m.type === 'register_native_executor') {
    registry.register(contextId, send);
    return 'registered';
  }
  if (m.type === 'browser_op_result' && typeof m.opId === 'string') {
    registry.resolveOp({ opId: m.opId, result: m.result, error: m.error });
    return 'result';
  }
  return null;
}
