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
  /** Mark a contextId as client-executed and store its outbound `send`.
   *  `owner` identifies WHICH socket registered (the ws object itself works).
   *
   *  NON è più un last-write-wins incondizionato. `unregister` aveva una guardia
   *  di proprietà e `register` no: chiunque potesse aprire `/ws/browser/:ctx` su
   *  loopback col contextId di UN'ALTRA pane ne diventava l'esecutore,
   *  sovrascrivendo la registrazione legittima e ricevendo le sue tool-call —
   *  fra cui `browser_load_state`, cioè lo stato di sessione e i cookie. Avere
   *  la guardia sulla rimozione e non sull'aggiunta era un'asimmetria, non una
   *  decisione.
   *
   *  La regola ora: un secondo registrante su un contextId OCCUPATO E VIVO
   *  viene rifiutato. Vivo lo dice `isOwnerAlive`, che il chiamante inietta
   *  (per un WS: `readyState === OPEN`) — ed è ciò che tiene in piedi la
   *  riconnessione, il caso che la guardia di `unregister` esiste per
   *  proteggere: quando una pane riconnette, il socket vecchio è già chiuso,
   *  quindi non è vivo e il subentro è legittimo.
   *
   *  Senza `isOwnerAlive` non si può distinguere un subentro legittimo da un
   *  dirottamento: in quel caso si consente (comportamento storico) ma lo si
   *  LOGGA, così un chiamante non aggiornato si vede.
   *
   *  @returns `true` se la registrazione è stata accettata. */
  register(contextId: string, send: SendFn, owner?: unknown, isOwnerAlive?: () => boolean): boolean;
  /** Drop a contextId (client disconnected / pane closed). Rejects its in-flight ops.
   *  When `owner` is passed and doesn't match the CURRENT registration's owner,
   *  this is a no-op: it means a newer socket already re-registered (reconnect)
   *  and the caller is only cleaning up a stale/older socket — killing the fresh
   *  registration would silently reroute agent ops to the headless Playwright
   *  context instead of the user's live native pane. */
  unregister(contextId: string, owner?: unknown): void;
  /** Is this contextId currently client-delegated (a live native pane)? */
  isDelegated(contextId: string): boolean;
  /** Forward a tool-call to the client and await its reply (or a timeout error). */
  delegateOp(contextId: string, tool: string, args: unknown): Promise<unknown>;
  /** Feed an inbound `browser_op_result` from the client; resolves the pending op. */
  resolveOp(res: BrowserOpResult): void;
  /** Count of registered contexts (introspection / tests). */
  size(): number;
  /** Ids of every currently client-delegated (live native) pane. This map IS
   *  the inventory of live WKWebView panes — every native pane registers here on
   *  mount — so the tab-inventory (browser-tab-inventory.ts) enumerates it. */
  listDelegated(): string[];
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

  const senders = new Map<string, { send: SendFn; owner?: unknown; isOwnerAlive?: () => boolean }>();
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
    register(contextId, send, owner, isOwnerAlive) {
      const current = senders.get(contextId);
      // Ri-registrazione dello STESSO socket: è un refresh, sempre lecita.
      const sameOwner =
        current !== undefined && owner !== undefined && current.owner === owner;
      if (current && !sameOwner) {
        // C'è già un esecutore. Subentrare è legittimo solo se quello vecchio
        // non c'è più (riconnessione: il socket precedente è chiuso).
        const alive = current.isOwnerAlive?.();
        if (alive === true) {
          console.warn(
            `[native-delegate] registrazione RIFIUTATA su ${contextId}: ` +
              `un esecutore vivo lo serve già. Un secondo socket che si registra su un ` +
              `contextId occupato ne dirotterebbe le tool-call (incluso browser_load_state).`,
          );
          return false;
        }
        if (alive === undefined) {
          // Nessun modo di sapere se il vecchio è vivo → si consente, come da
          // comportamento storico, ma non in silenzio: è un chiamante che non
          // inietta `isOwnerAlive`, e va aggiornato.
          console.warn(
            `[native-delegate] subentro su ${contextId} senza prova di liveness del ` +
              `precedente esecutore: il chiamante non passa isOwnerAlive.`,
          );
        }
      }
      senders.set(contextId, { send, owner, isOwnerAlive });
      return true;
    },
    unregister(contextId, owner) {
      // Ownership guard (reconnect race): if the caller identifies itself and a
      // DIFFERENT socket now owns the registration, leave it alone. Concrete
      // sequence this prevents: pane reconnects and re-registers on a new WS →
      // up to 90s later the heartbeat reaper (or the old socket's late `close`)
      // fires unregister for the OLD socket → without the guard it would drop
      // the fresh registration. In-flight ops sent via the old socket simply
      // hit their own 30s timeout.
      const current = senders.get(contextId);
      if (owner !== undefined && current !== undefined && current.owner !== owner) return;
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
      const send = senders.get(contextId)?.send;
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
    listDelegated() {
      return [...senders.keys()];
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
  owner?: unknown,
  isOwnerAlive?: () => boolean,
): 'registered' | 'rejected' | 'result' | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { type?: string; opId?: string; result?: unknown; error?: string };
  if (m.type === 'register_native_executor') {
    // 'rejected' quando un esecutore vivo serve gia questo contextId: chi
    // chiama deve poterlo dire al socket invece di credersi registrato.
    return registry.register(contextId, send, owner, isOwnerAlive) ? 'registered' : 'rejected';
  }
  if (m.type === 'browser_op_result' && typeof m.opId === 'string') {
    registry.resolveOp({ opId: m.opId, result: m.result, error: m.error });
    return 'result';
  }
  return null;
}
