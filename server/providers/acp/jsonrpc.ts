/**
 * Il filo di ACP: JSON-RPC 2.0, un messaggio per riga, su stdio.
 *
 * Sta in un file suo e NON sa niente né di provider né di chat, per una ragione
 * pratica: il pezzo che si rompe davvero in un'integrazione così non è la
 * semantica dell'agente, è il trasporto — una riga spezzata a metà da un chunk,
 * una risposta che arriva dopo che il processo è morto, una richiesta
 * dell'agente a cui nessuno risponde e che lo lascia appeso per sempre. Tutte
 * cose che si provano con due stringhe e nessun processo, se il trasporto è
 * isolato.
 *
 * Regole del trasporto, che sono anche i suoi test:
 *  • Il framing è a righe. `feed()` accetta chunk di qualunque taglio: una riga
 *    tagliata a metà resta nel buffer finché non arriva il resto.
 *  • Una riga illeggibile NON uccide la connessione. Gli agenti scrivono anche
 *    rumore su stdout (banner, warning di node): si scarta la riga e si va
 *    avanti, altrimenti un `console.log` di troppo dell'agente farebbe cadere
 *    la sessione.
 *  • Ogni richiesta ENTRANTE riceve sempre una risposta — anche quando non
 *    sappiamo cosa farne (`-32601`) o l'handler lancia (`-32603`). Un agente
 *    che aspetta una risposta che non arriva non va in errore: si ferma, e un
 *    turno fermo è la cosa più difficile da diagnosticare.
 *  • `close()` rigetta ogni richiesta in volo. Senza, la morte del processo si
 *    manifesta come una promise che non si risolve mai.
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = "JsonRpcRemoteError";
    this.code = err.code;
    this.data = err.data;
  }
}

/** Codici standard JSON-RPC che ci servono davvero. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

type Params = Record<string, unknown>;

export type RequestHandler = (params: Params) => unknown | Promise<unknown>;
export type NotificationHandler = (params: Params) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export interface JsonRpcPeerOptions {
  /** Scrive UNA riga (senza `\n`: lo aggiunge il peer) verso l'altro capo. */
  write: (line: string) => void;
  /** Diagnostica di trasporto. Volutamente non `console.*` di default. */
  onTransportError?: (message: string, raw?: string) => void;
}

export class JsonRpcPeer {
  private readonly write: (line: string) => void;
  private readonly onTransportError: (message: string, raw?: string) => void;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(opts: JsonRpcPeerOptions) {
    this.write = opts.write;
    this.onTransportError = opts.onTransportError ?? (() => {});
  }

  // ── Uscita ────────────────────────────────────────────────────────────────

  /** Richiesta con risposta. Rigetta con `JsonRpcRemoteError` se l'altro capo risponde errore. */
  request<T = unknown>(method: string, params?: Params): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ACP_CONNECTION_CLOSED"));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
    });
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return promise;
  }

  /** Notifica: nessun id, nessuna risposta attesa. */
  notify(method: string, params?: Params): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  // ── Registrazione ─────────────────────────────────────────────────────────

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  // ── Entrata ───────────────────────────────────────────────────────────────

  /** Dà al peer un pezzo qualunque di stdout. Il taglio non conta. */
  feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Rumore sullo stdout dell'agente: si scarta la riga, non la sessione.
      this.onTransportError("riga non-JSON scartata", line);
      return;
    }
    if (!msg || typeof msg !== "object") {
      this.onTransportError("messaggio non-oggetto scartato", line);
      return;
    }
    const m = msg as Record<string, unknown>;
    const hasId = m.id !== undefined && m.id !== null;

    if (typeof m.method === "string") {
      const params = (m.params && typeof m.params === "object" ? m.params : {}) as Params;
      if (hasId) void this.handleIncomingRequest(m.id as number | string, m.method, params);
      else this.handleIncomingNotification(m.method, params);
      return;
    }

    if (hasId) {
      this.handleResponse(m);
      return;
    }
    this.onTransportError("messaggio senza method né id scartato", line);
  }

  private handleIncomingNotification(method: string, params: Params): void {
    const handler = this.notificationHandlers.get(method);
    if (!handler) return; // Una notifica ignota si ignora: è il suo contratto.
    try {
      handler(params);
    } catch (err) {
      this.onTransportError(`handler della notifica ${method} ha lanciato: ${errText(err)}`);
    }
  }

  private async handleIncomingRequest(id: number | string, method: string, params: Params): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      // Rispondere "non so farlo" è la cosa giusta: l'agente ha un ramo per
      // questo caso, per "nessuna risposta" non ce l'ha.
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? {} : result });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_INTERNAL_ERROR, message: errText(err) },
      });
    }
  }

  private handleResponse(m: Record<string, unknown>): void {
    const id = typeof m.id === "number" ? m.id : Number(m.id);
    const pending = this.pending.get(id);
    if (!pending) {
      // Risposta a una richiesta che non abbiamo fatto (o già chiusa).
      this.onTransportError(`risposta senza richiesta in attesa (id ${String(m.id)})`);
      return;
    }
    this.pending.delete(id);
    if (m.error && typeof m.error === "object") {
      const e = m.error as Record<string, unknown>;
      pending.reject(
        new JsonRpcRemoteError({
          code: typeof e.code === "number" ? e.code : RPC_INTERNAL_ERROR,
          message: typeof e.message === "string" ? e.message : `${pending.method} fallito`,
          data: e.data,
        }),
      );
      return;
    }
    pending.resolve(m.result);
  }

  // ── Chiusura ──────────────────────────────────────────────────────────────

  /**
   * Chiude il peer e rigetta TUTTO ciò che era in volo. Idempotente: la morte
   * di un processo arriva spesso due volte (exit + close dello stream).
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(reason);
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    this.buffer = "";
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Quante richieste sono in volo. Serve alla diagnostica, non alla logica. */
  get inFlight(): number {
    return this.pending.size;
  }

  private send(msg: Record<string, unknown>): void {
    try {
      this.write(JSON.stringify(msg));
    } catch (err) {
      this.onTransportError(`scrittura fallita: ${errText(err)}`);
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "errore sconosciuto");
}
