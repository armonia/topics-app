/**
 * OpenClawProvider — AIProvider implementation that wraps GatewayWS.
 *
 * Thin wrapper: all WebSocket logic lives in gateway-ws.ts,
 * this just adapts it to the AIProvider interface.
 */

import {
  type AIProvider,
  type ChatMessage,
  type CompletionResult,
  type OpenClawProviderConfig,
  type ProviderCapability,
  type ProviderDiagnostic,
  type ProviderRequirement,
  type StreamHandler,
} from "./types";
import { checkGatewayHealth } from "./health";

import {
  type ChatStreamHandler,
  type GatewayEvent,
  GatewayWS,
  initGatewayWS,
  registerSessionHandler,
  unregisterSessionHandler,
  routeGatewayEvent,
} from "../gateway-ws";

/** Adapt StreamHandler (optional onAborted) to ChatStreamHandler (required onAborted) */
function toChatStreamHandler(h: StreamHandler): ChatStreamHandler {
  return {
    onTextDelta: h.onTextDelta,
    onThinkingDelta: h.onThinkingDelta,
    onToolStart: h.onToolStart,
    onToolUpdate: h.onToolUpdate,
    onToolResult: h.onToolResult,
    onDone: h.onDone,
    onError: h.onError,
    onAborted: h.onAborted ?? (() => {}),
  };
}

// ============ Provider ============

export class OpenClawProvider implements AIProvider {
  readonly name = "openclaw";
  readonly capabilities = new Set<ProviderCapability>([
    "streaming",
    "tools",
    "thinking",
    "sessions",
    "abort",
    "context",
    // Topics-app reconstructs the conversation from its local SQLite messages
    // table on every turn and forwards it via `options.history`. The gateway
    // can ignore the field for backwards compatibility (its existing
    // session-resident state still works) but when the gateway loses state
    // — process restart, session expiry, child respawn — the history we
    // hand off lets it rehydrate the conversation. This is the openclaw
    // counterpart to claude-code's `--resume` persistence (mem-6d9f7a9b0e3b).
    "history",
  ]);
  // Gateway is stateful but accepts `options.history` for restart rehydration.
  // The inspector should communicate this duality (gateway may ignore the
  // field on the happy path). See `server/context/adapt.ts`.
  readonly contextStrategy = "gateway-stateful" as const;

  private config: OpenClawProviderConfig;
  private gw: GatewayWS | null = null;
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<(reason: string) => void> = [];

  constructor(config: OpenClawProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.gw?.connected ?? false;
  }

  // --- Lifecycle ---

  start(): void {
    const opts: any = {
      gatewayUrl: this.config.gatewayUrl,
      token: this.config.token,
      onEvent: (event: GatewayEvent) => this.routeEvent(event),
      onConnect: () => this.connectHandlers.forEach((h) => h()),
      onDisconnect: (reason: string) => this.disconnectHandlers.forEach((h) => h(reason)),
    };
    // Pass auth refresh callback if available
    if (this.config.refreshToken) {
      opts.onAuthFailure = () => this.config.refreshToken!();
    }
    this.gw = initGatewayWS(opts);
  }

  stop(): void {
    this.gw?.stop();
    this.gw = null;
  }

  // --- Streaming Chat ---

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[] },
  ): Promise<{ runId?: string }> {
    // OpenClaw routes through the gateway which selects models server-side;
    // per-request `model` overrides aren't plumbed through the WS protocol yet.
    // `history` is forwarded so the gateway can rehydrate after losing its
    // session state (see capability comment above).
    this.ensureConnected();
    const result = await this.gw!.sendChat(sessionKey, message, options?.history);
    registerSessionHandler(sessionKey, result.runId, toChatStreamHandler(handler));
    return result;
  }

  registerStreamHandler(sessionKey: string, runId: string | undefined, handler: StreamHandler): void {
    registerSessionHandler(sessionKey, runId, toChatStreamHandler(handler));
  }

  unregisterStreamHandler(sessionKey: string): void {
    unregisterSessionHandler(sessionKey);
  }

  // --- HTTP Streaming (SSE) ---

  async streamHTTP(
    messages: ChatMessage[],
    options?: { sessionKey?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const token = this.freshToken();
    return fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-openclaw-scopes": "operator.read,operator.write",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openclaw", stream: true, messages }),
      signal: options?.signal,
    });
  }

  // --- Non-streaming ---

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    const token = this.freshToken();
    const res = await fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-openclaw-scopes": "operator.read,operator.write",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openclaw", stream: false, messages }),
    });

    if (!res.ok) {
      throw new Error(`completion failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  // --- Session Management ---

  async abort(sessionKey: string, runId?: string): Promise<void> {
    this.ensureConnected();
    await this.gw!.abortChat(sessionKey, runId);
  }

  async getHistory(sessionKey: string, limit?: number): Promise<any> {
    this.ensureConnected();
    return this.gw!.getHistory(sessionKey, limit);
  }

  async pauseSession(sessionKey: string): Promise<void> {
    const token = this.freshToken();
    const res = await fetch(
      `${this.config.gatewayUrl}/api/agents/sessions/${encodeURIComponent(sessionKey)}/pause`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "x-openclaw-scopes": "operator.read,operator.write",
          "Content-Type": "application/json",
        },
      },
    );
    if (!res.ok) throw new Error(`pauseSession failed: ${res.status}`);
  }

  async resumeSession(sessionKey: string): Promise<void> {
    const token = this.freshToken();
    const res = await fetch(
      `${this.config.gatewayUrl}/api/agents/sessions/${encodeURIComponent(sessionKey)}/resume`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "x-openclaw-scopes": "operator.read,operator.write",
          "Content-Type": "application/json",
        },
      },
    );
    if (!res.ok) throw new Error(`resumeSession failed: ${res.status}`);
  }

  async listSessions(options?: { kinds?: string[]; activeMinutes?: number }): Promise<any> {
    return this.toolPost("sessions_list", options ?? {});
  }

  async sendToSession(sessionKey: string, message: string): Promise<void> {
    await this.toolPost("sessions_send", { sessionKey, message });
  }

  async getSessionStatus(sessionKey: string): Promise<any> {
    return this.toolPost("session_status", { sessionKey });
  }

  // --- Tools RPC ---

  async invokeTool(tool: string, args: Record<string, any>): Promise<any> {
    return this.toolPost(tool, args);
  }

  // --- Diagnostics ---

  async diagnose(): Promise<ProviderDiagnostic> {
    const requirements: ProviderRequirement[] = [
      {
        key: "GATEWAY_URL",
        label: "Gateway URL",
        present: Boolean(this.config.gatewayUrl),
        hint: this.config.gatewayUrl ? undefined : "Set GATEWAY_URL in your environment.",
      },
      {
        key: "GATEWAY_TOKEN",
        label: "Gateway token",
        present: Boolean(this.config.token),
        hint: this.config.token ? undefined : "Set GATEWAY_TOKEN, or run OpenClaw to write ~/.openclaw/openclaw.json",
      },
    ];

    const allReq = requirements.every((r) => r.present);
    if (!allReq) {
      return { name: this.name, status: "unavailable", requirements };
    }

    const health = await checkGatewayHealth(this.config.gatewayUrl, this.freshToken());
    if (health.online) {
      return { name: this.name, status: "ready", requirements };
    }
    // Distinguish "server simply off" (unavailable) from "configured but broken" (error).
    // Connection refused / timeout / generic offline = the gateway just isn't running.
    // 401/403 / 5xx = configuration is wrong or server is broken.
    const offlineStates = new Set(["connection_refused", "timeout", "offline"]);
    const isJustOff = offlineStates.has(health.status);
    return {
      name: this.name,
      status: isJustOff ? "unavailable" : "error",
      requirements,
      lastError: isJustOff
        ? "Gateway not reachable. Start the OpenClaw server."
        : health.error ?? health.status,
    };
  }

  async listModels(): Promise<string[]> {
    return ["openclaw"];
  }

  // --- Event Routing ---

  routeEvent(event: GatewayEvent): boolean {
    return routeGatewayEvent(event);
  }

  // --- Provider events ---

  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandlers.push(handler);
  }

  // --- Internal helpers ---

  private freshToken(): string {
    if (this.config.refreshToken) {
      const fresh = this.config.refreshToken();
      if (fresh) this.config.token = fresh;
    }
    return this.config.token;
  }

  private ensureConnected(): void {
    if (!this.gw) throw new Error("OpenClawProvider not started");
  }

  private async toolPost(tool: string, args: Record<string, any>): Promise<any> {
    const token = this.freshToken();
    const res = await fetch(`${this.config.gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-openclaw-scopes": "operator.read,operator.write",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool, args }),
    });
    if (!res.ok) throw new Error(`tool ${tool} failed: ${res.status}`);
    return res.json();
  }
}
