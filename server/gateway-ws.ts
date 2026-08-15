/**
 * Gateway WebSocket Client for Topics
 * 
 * Connects to the OpenClaw gateway via WebSocket to send chat messages
 * and receive streaming events (text deltas, tool calls, etc.)
 * 
 * Protocol reverse-engineered from the Control UI source.
 */

import type { ChatMessage } from "./providers/types";
import { nextTextDelta } from "./providers/text-delta";

// --- Types ---

interface GatewayWSOptions {
  url: string;       // ws://127.0.0.1:18789/
  token: string;     // gateway auth token
  onEvent?: (event: GatewayEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onAuthFailure?: () => string | null; // Called on auth failure — return fresh token or null
}

interface GatewayRequest {
  type: "req";
  id: string;
  method: string;
  params: any;
}

interface GatewayResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: any;
  error?: { code?: string; message?: string; details?: any };
}

export interface GatewayEvent {
  type: "event";
  event: string;    // "chat", "agent", "connect.challenge", etc.
  payload?: any;
  seq?: number;
}

// Chat event payload shape
export interface ChatEventPayload {
  sessionKey?: string;
  runId?: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: any;
  errorMessage?: string;
}

// Agent event payload shape  
export interface AgentEventPayload {
  sessionKey?: string;
  runId?: string;
  stream: string;     // "tool", "compaction", "lifecycle", "fallback", "output", "thought"
  data?: any;
  ts?: number;
}

// --- Helpers ---

function extractText(message: any): string | null {
  if (!message) return null;
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
  }
  return null;
}

// --- Client ---

export class GatewayWS {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  private connectSent = false;
  private backoffMs = 800;
  private opts: GatewayWSOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private authFailureCount = 0;
  private static readonly AUTH_FAILURE_LIMIT = 3;
  private static readonly AUTH_COOLDOWN_MS = 60_000;

  constructor(opts: GatewayWSOptions) {
    this.opts = opts;
  }

  get connected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Update the auth token (e.g., after reading fresh token from openclaw.json) */
  updateToken(token: string): void {
    if (token && token !== this.opts.token) {
      this.opts.token = token;
      this.authFailureCount = 0; // Reset circuit breaker
      console.log("[GatewayWS] Token updated — will use on next connect");
    }
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this.flushPending(new Error("gateway client stopped"));
  }

  private connect(): void {
    if (this.closed) return;
    
    try {
      // Pass origin header so gateway accepts the connection
      this.ws = new WebSocket(this.opts.url, {
        headers: { "Origin": "https://localhost:3333" }
      } as any);
    } catch (err) {
      console.error("[GatewayWS] Failed to create WebSocket:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      console.log("[GatewayWS] WebSocket opened, waiting for challenge...");
      this.connectSent = false;
      // Wait a bit for challenge, then send connect anyway
      setTimeout(() => {
        if (!this.connectSent && !this.closed) {
          this.sendConnect();
        }
      }, 1000);
    });

    this.ws.addEventListener("message", (ev) => {
      this.handleMessage(String(ev.data ?? ""));
    });

    this.ws.addEventListener("close", (ev) => {
      const reason = ev.reason || "unknown";
      console.log(`[GatewayWS] WebSocket closed (${ev.code}): ${reason}`);
      this.ws = null;
      this._connected = false;
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onDisconnect?.(reason);
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[GatewayWS] WebSocket error", (err as any)?.message ?? err);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
    console.log(`[GatewayWS] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent) return;
    this.connectSent = true;

    const connectParams: any = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: "server",
        mode: "ui",
        instanceId: crypto.randomUUID(),
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: ["tool-events"],
      auth: {
        token: this.opts.token,
      },
    };
    // nonce is used for device auth only, not needed for token auth

    try {
      // L'await serve (è lui che fallisce se il gateway rifiuta), la risposta no.
      await this.request("connect", connectParams);
      console.log("[GatewayWS] Connected to gateway successfully");
      this._connected = true;
      this.backoffMs = 800;
      this.authFailureCount = 0; // Reset on success
      this.opts.onConnect?.();
    } catch (err: any) {
      const isAuthError = err.message?.includes("unauthorized") || err.message?.includes("token") || err.code === "UNAUTHORIZED";
      if (isAuthError) {
        this.authFailureCount++;
        console.error(`[GatewayWS] Auth failure ${this.authFailureCount}/${GatewayWS.AUTH_FAILURE_LIMIT}: ${err.message}`);

        // Try refreshing token from openclaw.json
        if (this.opts.onAuthFailure) {
          const freshToken = this.opts.onAuthFailure();
          if (freshToken && freshToken !== this.opts.token) {
            this.opts.token = freshToken;
            this.authFailureCount = 0; // Reset — new token, try fresh
            console.log("[GatewayWS] Token refreshed, will retry immediately");
          }
        }

        // Circuit breaker: after AUTH_FAILURE_LIMIT consecutive failures, pause
        if (this.authFailureCount >= GatewayWS.AUTH_FAILURE_LIMIT) {
          console.error(`[GatewayWS] Circuit breaker: ${this.authFailureCount} auth failures, pausing ${GatewayWS.AUTH_COOLDOWN_MS / 1000}s. Check GATEWAY_TOKEN in .env or ~/.openclaw/openclaw.json`);
          this.backoffMs = GatewayWS.AUTH_COOLDOWN_MS;
        }
      } else {
        console.error("[GatewayWS] Connect failed:", err.message);
      }
      this.ws?.close(4008, "connect failed");
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    
    if (msg.type === "event") {
      const event = msg as GatewayEvent;


      // Handle connect challenge
      if (event.event === "connect.challenge") {
        // Il nonce si LEGGE ma non si conserva: serviva alla device auth, che qui
        // non esiste più (`sendConnect` manda il token — vedi il commento lì).
        // Restava un campo `connectNonce` scritto in due punti e letto da nessuno,
        // cioè stato morto che faceva sembrare implementato un secondo modo di
        // autenticarsi. Del challenge conta solo il segnale: il gateway è pronto.
        if (typeof event.payload?.nonce === "string") {
          this.connectSent = false;
          this.sendConnect();
        }
        return;
      }

      // Forward to event handler
      try {
        this.opts.onEvent?.(event);
      } catch (err) {
        console.error("[GatewayWS] Event handler error:", err);
      }
      return;
    }

    if (msg.type === "res") {
      const res = msg as GatewayResponse;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        const err = new Error(res.error?.message ?? "request failed");
        (err as any).code = res.error?.code;
        (err as any).details = res.error?.details;
        pending.reject(err);
      }
    }
  }

  request(method: string, params: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }

    const id = crypto.randomUUID();
    const req: GatewayRequest = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(req));

      // Bound EVERY request so a silent (half-open) gateway can't leak the
      // pending entry — and its awaiting caller — forever. chat.send can run
      // long (its res may not arrive until the streamed turn finishes), so it
      // gets a generous 30-min cap rather than the 30s used for quick RPCs;
      // but it is no longer unbounded (the old `!== chat.send` skip leaked the
      // pending entry on a lost res frame over a still-open socket).
      const timeoutMs = method === "chat.send" ? 30 * 60_000 : 30_000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  // --- High-level API ---

  async sendChat(
    sessionKey: string,
    message: string,
    history?: ChatMessage[],
  ): Promise<{ runId?: string }> {
    const idempotencyKey = crypto.randomUUID();
    // `history` is sent as an optional field — gateways that don't know about
    // it ignore it harmlessly (JSON-RPC strict-field gateways are not in
    // scope; this is a passthrough WS request). When present, the gateway
    // can rehydrate a lost session instead of replying out of context.
    const params: Record<string, unknown> = {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey,
    };
    if (history && history.length > 0) params.history = history;
    const result = await this.request("chat.send", params);
    return { runId: result?.runId || idempotencyKey };
  }

  async getHistory(sessionKey: string, limit = 200): Promise<any> {
    return this.request("chat.history", { sessionKey, limit });
  }

  async abortChat(sessionKey: string, runId?: string): Promise<any> {
    return this.request("chat.abort", runId ? { sessionKey, runId } : { sessionKey });
  }
}

// --- Per-session event routing ---

export interface ChatStreamHandler {
  /** Same contract as `StreamHandler.onTextDelta`: `(newPart, cumulative)`. */
  onTextDelta: (text: string, fullText: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart: (toolCallId: string, name: string, args?: Record<string, unknown>) => void;
  onToolUpdate?: (toolCallId: string, partialResult: string) => void;
  onToolResult: (toolCallId: string, result: string) => void;
  onDone: (message?: Record<string, unknown>) => void;
  onError: (error: string) => void;
  onAborted: (message?: Record<string, unknown>) => void;
}

/** 
 * Maps sessionKey → active stream handler.
 * When a chat.send is in progress, events for that session are routed here.
 */
const sessionHandlers = new Map<string, {
  runId?: string;
  handler: ChatStreamHandler;
  /**
   * Ultimo testo CUMULATIVO ricevuto dal gateway su questa sessione.
   *
   * Il gateway è l'unico dei cinque provider a mandare il messaggio intero a
   * ogni evento `delta`; il contratto di `onTextDelta` vuole il pezzo nuovo.
   * La differenza si fa qui, dove il cumulato è un dato del mittente, invece
   * che nella route, dove era un'ipotesi applicata a tutti (e costava un token
   * ripetuto ai quattro provider che i delta li mandano veri).
   */
  lastCumulativeText?: string;
}>();

/** Normalize gateway session key (agent:main:topic:xxx → topic:xxx) */
function normalizeSessionKey(key: string | undefined): string | undefined {
  if (!key) return key;
  // Gateway uses "agent:main:topic:xxx", Topics uses "topic:xxx"
  const match = key.match(/topic:[a-zA-Z0-9_-]+$/);
  return match ? match[0] : key;
}

export function registerSessionHandler(sessionKey: string, runId: string | undefined, handler: ChatStreamHandler): void {
  // Il cumulato sopravvive alla RI-registrazione dello stesso turno, non a un
  // turno nuovo. La route registra due volte di fila — prima senza runId (per
  // non perdere gli eventi che arrivano durante la `sendChat`), poi con quello
  // vero — e in mezzo passano dei delta: azzerarlo lì rimanderebbe alla route
  // tutto il testo già visto come se fosse nuovo, cioè la risposta due volte.
  // Un runId diverso da uno già noto è invece un altro turno: si riparte da zero.
  const prior = sessionHandlers.get(sessionKey);
  const carry = prior && (prior.runId === undefined || prior.runId === runId)
    ? prior.lastCumulativeText
    : undefined;
  sessionHandlers.set(sessionKey, { runId, handler, lastCumulativeText: carry });
}

export function unregisterSessionHandler(sessionKey: string): void {
  sessionHandlers.delete(sessionKey);
}

/**
 * Route a gateway event to the appropriate session handler.
 * Returns true if handled.
 */
export function routeGatewayEvent(event: GatewayEvent): boolean {
  if (event.event === "chat") {
    const payload = event.payload as ChatEventPayload;
    const sessionKey = normalizeSessionKey(payload?.sessionKey);
    if (!sessionKey) return false;
    
    console.log(`[GatewayWS:Route] chat event for ${sessionKey}, state=${payload.state}, handlers=[${[...sessionHandlers.keys()].join(',')}]`);
    
    const entry = sessionHandlers.get(sessionKey);
    if (!entry) return false;
    
    // CHAT-REL-04: Ignore stale events. HTTP-path handlers use sentinel runId (http:*)
    // which never matches gateway runIds, so stale chat events are always rejected.
    // Tool events (via "agent" event type) are routed separately and still work.
    if (entry.runId && payload.runId && payload.runId !== entry.runId) {
      // Don't log for http: sentinel — this is expected behavior, not stale
      if (!entry.runId.startsWith('http:')) {
        console.log(`[GatewayWS:Route] ignoring stale chat event runId=${payload.runId?.slice(0,8)} (expected ${entry.runId?.slice(0,8)})`);
      }
      return true; // consumed but ignored
    }

    const handler = entry.handler;

    switch (payload.state) {
      case "delta": {
        const text = extractText(payload.message);
        if (typeof text === "string") {
          const step = nextTextDelta(entry.lastCumulativeText ?? "", text);
          entry.lastCumulativeText = step.cumulative;
          // Un cumulato identico al precedente non porta niente: qui, e solo
          // qui, «uguale a prima» vuole davvero dire «nessun testo nuovo».
          if (step.delta) handler.onTextDelta(step.delta, step.cumulative);
        }
        break;
      }
      case "final": {
        handler.onDone(payload.message);
        break;
      }
      case "aborted": {
        handler.onAborted(payload.message);
        break;
      }
      case "error": {
        handler.onError(payload.errorMessage ?? "chat error");
        break;
      }
    }
    return true;
  }

  if (event.event === "agent") {
    const payload = event.payload as AgentEventPayload;

    // Thought/thinking deltas MUST be handled before the tool guard below.
    // This used to live in a second `if (event.event === "agent")` block AFTER
    // the tool one — but the tool block's `stream !== "tool"` early `return false`
    // swallowed every non-tool agent event first, making that later block
    // unreachable dead code (agent reasoning deltas were silently dropped).
    if (payload?.stream === "thought" || payload?.stream === "thinking") {
      const sessionKey = normalizeSessionKey(payload.sessionKey);
      if (!sessionKey) return false;
      const entry = sessionHandlers.get(sessionKey);
      if (!entry) return false;
      const text = payload.data?.text || payload.data?.content;
      if (typeof text === "string") {
        entry.handler.onThinkingDelta?.(text);
      }
      return true;
    }

    if (payload?.stream !== "tool") return false;

    const sessionKey = normalizeSessionKey(payload.sessionKey);
    if (!sessionKey) return false;

    const entry = sessionHandlers.get(sessionKey);
    if (!entry) return false;

    // Ignore stale run events — but NOT for http: sentinel handlers.
    // HTTP fallback handlers use sentinel runIds (http:*) that never match gateway runIds,
    // so we must skip this filter for them or all tool events get silently dropped.
    if (entry.runId && payload.runId && payload.runId !== entry.runId && !entry.runId.startsWith('http:')) return true;

    const handler = entry.handler;
    const data = payload.data;
    if (!data?.toolCallId) return false;

    const phase = data.phase as string;
    const toolCallId = data.toolCallId as string;
    const name = (data.name as string) || "tool";

    switch (phase) {
      case "start":
        handler.onToolStart(toolCallId, name, data.args);
        break;
      case "update":
        handler.onToolUpdate?.(toolCallId, typeof data.partialResult === "string" ? data.partialResult : JSON.stringify(data.partialResult ?? ""));
        break;
      case "result":
        handler.onToolResult(toolCallId, typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? ""));
        break;
    }
    return true;
  }

  return false;
}

// --- Singleton ---

let instance: GatewayWS | null = null;

export function getGatewayWS(): GatewayWS | null {
  return instance;
}

export interface InitGatewayWSOptions {
  gatewayUrl: string;
  token: string;
  onEvent?: (event: GatewayEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onAuthFailure?: () => string | null;
}

export function initGatewayWS(opts: InitGatewayWSOptions): GatewayWS {
  if (instance) {
    instance.stop();
  }

  // Convert HTTP URL to WS URL
  let wsUrl = opts.gatewayUrl;
  wsUrl = wsUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  if (!wsUrl.endsWith("/")) wsUrl += "/";

  console.log(`[GatewayWS] Initializing connection to ${wsUrl}`);

  instance = new GatewayWS({
    url: wsUrl,
    token: opts.token,
    onEvent: opts.onEvent,
    onConnect: opts.onConnect,
    onDisconnect: opts.onDisconnect,
    onAuthFailure: opts.onAuthFailure,
  });

  instance.start();
  return instance;
}

// --- Utility: extract text from chat event message ---
export { extractText };
