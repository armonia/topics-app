/**
 * AIProvider — abstraction layer for AI inference backends.
 *
 * Implementations:
 *   - OpenClawProvider: wraps gateway-ws.ts (WebSocket + HTTP to OpenClaw Gateway)
 *   - ClaudeProvider:   uses Anthropic SDK directly (standalone mode)
 */

// ============ Message Types ============

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ============ Stream Event Types ============

/** Text chunk from the model */
export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
  /** Cumulative text so far (if available) */
  fullText?: string;
}

/** Model thinking/reasoning content */
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}

/** Tool call lifecycle */
export interface ToolStartEvent {
  type: "tool_start";
  toolCallId: string;
  name: string;
  args?: any;
}

export interface ToolUpdateEvent {
  type: "tool_update";
  toolCallId: string;
  partialResult: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  result: string;
}

/** Stream completed successfully */
export interface DoneEvent {
  type: "done";
  message?: any;
}

/** Stream errored */
export interface ErrorEvent {
  type: "error";
  error: string;
}

/** Stream aborted by user/system */
export interface AbortedEvent {
  type: "aborted";
  message?: any;
}

export type StreamEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolResultEvent
  | DoneEvent
  | ErrorEvent
  | AbortedEvent;

// ============ Completion (non-streaming) ============

export interface CompletionResult {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ============ Provider Capabilities ============

export type ProviderCapability =
  | "streaming"      // supports streamChat
  | "tools"          // tool call visibility during streaming
  | "thinking"       // extended thinking / reasoning visibility
  | "sessions"       // session management (pause, resume, history)
  | "abort"          // can abort an in-progress stream
  | "context";       // injects external context (OpenClaw SOUL.md, etc.)

// ============ Stream Handler (callback-style) ============

/** Callback-style handler — maps to the existing ChatStreamHandler pattern */
export interface StreamHandler {
  onTextDelta: (text: string, fullText: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart: (toolCallId: string, name: string, args?: any) => void;
  onToolUpdate?: (toolCallId: string, partialResult: string) => void;
  onToolResult: (toolCallId: string, result: string) => void;
  onDone: (message?: any) => void;
  onError: (error: string) => void;
  onAborted?: (message?: any) => void;
}

// ============ The Provider Interface ============

export interface AIProvider {
  /** Provider identifier */
  readonly name: string;

  /** What this provider supports */
  readonly capabilities: Set<ProviderCapability>;

  /** Whether the provider is currently connected/ready */
  readonly connected: boolean;

  // --- Lifecycle ---

  /** Initialize the provider (connect, authenticate, etc.) */
  start(): void;

  /** Shut down the provider */
  stop(): void;

  // --- Streaming Chat (primary) ---

  /**
   * Send a chat message and stream the response via callbacks.
   * Returns a runId for tracking/aborting.
   */
  sendChat(sessionKey: string, message: string, handler: StreamHandler): Promise<{ runId?: string }>;

  /**
   * Register a handler to receive stream events for a session.
   * Used when the provider pushes events asynchronously (e.g., WebSocket).
   */
  registerStreamHandler?(sessionKey: string, runId: string | undefined, handler: StreamHandler): void;

  /** Unregister a stream handler */
  unregisterStreamHandler?(sessionKey: string): void;

  // --- HTTP Streaming (SSE fallback) ---

  /**
   * Stream a chat completion via HTTP SSE.
   * Returns a Response with Content-Type: text/event-stream.
   * Used when WebSocket is unavailable or for simpler streaming.
   */
  streamHTTP?(
    messages: ChatMessage[],
    options?: { sessionKey?: string; signal?: AbortSignal }
  ): Promise<Response>;

  // --- Non-streaming ---

  /** Simple completion (non-streaming). For auto-naming, journal digests, etc. */
  complete(messages: ChatMessage[]): Promise<CompletionResult>;

  // --- Session Management (optional) ---

  abort?(sessionKey: string, runId?: string): Promise<void>;
  getHistory?(sessionKey: string, limit?: number): Promise<any>;
  pauseSession?(sessionKey: string): Promise<void>;
  resumeSession?(sessionKey: string): Promise<void>;
  listSessions?(options?: { kinds?: string[]; activeMinutes?: number }): Promise<any>;
  sendToSession?(sessionKey: string, message: string): Promise<void>;
  getSessionStatus?(sessionKey: string): Promise<any>;

  // --- Tools RPC (optional, OpenClaw-specific) ---

  invokeTool?(tool: string, args: Record<string, any>): Promise<any>;

  // --- Event routing ---

  /**
   * Handle a raw provider event and route it to registered handlers.
   * Returns true if the event was handled.
   */
  routeEvent?(event: any): boolean;

  /** Subscribe to provider-level events (connect, disconnect, etc.) */
  onConnect?(handler: () => void): void;
  onDisconnect?(handler: (reason: string) => void): void;
}

// ============ Provider Configuration ============

export interface OpenClawProviderConfig {
  type: "openclaw";
  gatewayUrl: string;
  token: string;
  refreshToken?: () => string;
}

export interface ClaudeProviderConfig {
  type: "claude";
  apiKey: string;
  model?: string;       // defaults to "claude-sonnet-4-20250514"
  maxTokens?: number;   // defaults to 8192
}

export interface ClaudeCodeProviderConfig {
  type: "claude-code";
  model?: string;           // defaults to "claude-sonnet-4-6"
  permissionMode?: string;  // defaults to "bypassPermissions"
  defaultWorkspace?: string; // defaults to HOME
}

export type ProviderConfig = OpenClawProviderConfig | ClaudeProviderConfig | ClaudeCodeProviderConfig;
