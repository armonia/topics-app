/**
 * AIProvider — abstraction layer for AI inference backends.
 *
 * Implementations:
 *   - OpenClawProvider: wraps gateway-ws.ts (WebSocket + HTTP to OpenClaw Gateway)
 *   - ClaudeProvider:   uses Anthropic SDK directly (standalone mode)
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// ============ Message Types ============

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ============ Stream Event Types ============

/**
 * Tool arguments arrive as JSON-decoded objects from the model.
 * Always an object (never an array/scalar at the top level), but the inner
 * fields are arbitrary, so we use `unknown` for the values.
 */
export type ToolArgs = Record<string, unknown>;

/**
 * Token usage attached to a completed turn. Field names mirror what the
 * providers actually emit (Claude Code uses `inputTokens`/`outputTokens`/
 * cache fields; Codex uses `input_tokens`/`output_tokens` which the provider
 * normalizes before passing it here).
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreation?: number;
  cacheRead?: number;
  reasoningTokens?: number;
}

/**
 * Trailing payload attached to `done` / `aborted` events.
 * Providers stuff arbitrary metadata here (token usage, finish_reason, raw
 * upstream object). The picker/footer code only reads known fields and falls
 * back gracefully, so the open shape is intentional.
 */
export interface ProviderDoneMessage {
  result?: string;
  usage?: ProviderUsage;
  /** End-to-end turn latency in milliseconds. */
  durationMs?: number;
  /** Total cost in USD reported by the provider. */
  costUsd?: number;
  /** Raw upstream payload — providers may surface their native shape here. */
  raw?: unknown;
  [key: string]: unknown;
}

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
  args?: ToolArgs;
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
  /**
   * True when the tool failed (Claude SDK sets this on `tool_result` blocks
   * whose content is an error message). Drives the UI to render a red ✗ and
   * status: 'error' instead of green ✓.
   */
  isError?: boolean;
}

/** Stream completed successfully */
export interface DoneEvent {
  type: "done";
  message?: ProviderDoneMessage;
}

/** Stream errored */
export interface ErrorEvent {
  type: "error";
  error: string;
}

/** Stream aborted by user/system */
export interface AbortedEvent {
  type: "aborted";
  message?: ProviderDoneMessage;
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
  | "context"        // injects external context (OpenClaw SOUL.md, etc.)
  | "history";       // accepts options.history on sendChat (stateless providers
                     // that need the full transcript every turn — claude, openai).
                     // Providers without this flag manage history internally
                     // (process-resident CLI, gateway-side session, etc.).

// ============ Status & Diagnostics ============

/** 4-state provider status (pattern from Paseo) */
export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface ProviderRequirement {
  /** Stable id, e.g. "GATEWAY_URL", "ANTHROPIC_API_KEY", "claude-cli" */
  key: string;
  /** Human-readable label */
  label: string;
  /** Whether this requirement is currently satisfied */
  present: boolean;
  /** Optional copy-paste hint to fix it (shell command, env var line, etc.) */
  hint?: string;
}

export interface ProviderDiagnostic {
  name: string;
  status: ProviderStatus;
  /** Set if provider is the current default */
  isDefault?: boolean;
  /** Filesystem path of the binary (for CLI providers) */
  binaryPath?: string;
  /** Detected version string */
  version?: string;
  /** Number of available models, if listModels is implemented */
  modelsCount?: number;
  /** Per-requirement breakdown */
  requirements: ProviderRequirement[];
  /** Last error message from a failed health-check */
  lastError?: string;
}

// ============ Stream Handler (callback-style) ============

/** Callback-style handler — maps to the existing ChatStreamHandler pattern */
export interface StreamHandler {
  onTextDelta: (text: string, fullText: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart: (toolCallId: string, name: string, args?: ToolArgs) => void;
  onToolUpdate?: (toolCallId: string, partialResult: string) => void;
  /**
   * Tool finished. `isError = true` means the tool reported a failure (Claude
   * SDK's `tool_result.is_error`). Default false; existing callers that pass
   * only 2 args remain valid.
   */
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void;
  /**
   * Sub-agent (Task tool) activity update. Fired when a Claude Code sidechain
   * emits a child event tagged with `parent_tool_use_id`. The provider's
   * SidechainTracker accumulates child events into an `actions[]` log keyed
   * by parent tool id; this callback delivers the latest snapshot so the
   * route can patch the parent Task call's `detail.sub_agent` and re-broadcast.
   *
   * `actions` is the full current log (snapshot, not a delta) — consumers
   * replace, not append. Bounded at 200 entries by the tracker.
   */
  onSubAgentUpdate?: (
    parentToolCallId: string,
    snapshot: {
      subAgentType?: string;
      description?: string;
      actions: Array<{ index: number; toolName: string; summary?: string; status?: 'running' | 'success' | 'error' }>;
      finished: boolean;
      result?: string;
    },
  ) => void;
  onDone: (message?: ProviderDoneMessage) => void;
  onError: (error: string) => void;
  onAborted?: (message?: ProviderDoneMessage) => void;
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
   *
   * `options.model` overrides the configured default for this single request,
   * without mutating shared provider config.
   */
  sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: {
      model?: string;
      /**
       * Prior conversation turns (excluding the new user message). Only
       * consumed by providers that declare the "history" capability —
       * stateless backends like the Anthropic and OpenAI APIs need the
       * full transcript every turn, while CLI/gateway providers ignore it
       * because they hold session state themselves.
       */
      history?: ChatMessage[];
      /**
       * Optional Anthropic-format Tool[] to register for this turn (Phase 30
       * BROWSER-CHAT-04). Providers with `isPassthroughProvider(name) === true`
       * forward to the underlying SDK; CLI/gateway providers ignore the field
       * (their tool surface is managed upstream).
       */
      tools?: Tool[];
    },
  ): Promise<{ runId?: string }>;

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
  getHistory?(sessionKey: string, limit?: number): Promise<unknown>;
  pauseSession?(sessionKey: string): Promise<void>;
  resumeSession?(sessionKey: string): Promise<void>;
  listSessions?(options?: { kinds?: string[]; activeMinutes?: number }): Promise<unknown>;
  sendToSession?(sessionKey: string, message: string): Promise<void>;
  getSessionStatus?(sessionKey: string): Promise<unknown>;

  // --- Tools RPC (optional, OpenClaw-specific) ---

  invokeTool?(tool: string, args: ToolArgs): Promise<unknown>;

  // --- Diagnostics ---

  /** Inspect config + connectivity. Returns a structured report for the UI. */
  diagnose?(): Promise<ProviderDiagnostic>;

  /** List available models for this provider (for the picker UI) */
  listModels?(): Promise<string[]>;

  // --- Event routing ---

  /**
   * Handle a raw provider event and route it to registered handlers.
   * Returns true if the event was handled.
   */
  routeEvent?(event: unknown): boolean;

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

export interface CodexProviderConfig {
  type: "codex";
  model?: string;             // defaults to "gpt-5-codex"
  approvalMode?: "auto" | "full-access";
  defaultWorkspace?: string;  // defaults to HOME
}

export interface OpenAIProviderConfig {
  type: "openai";
  apiKey: string;
  model?: string;             // defaults to "gpt-4o"
  maxTokens?: number;         // defaults to 8192
}

export type ProviderConfig =
  | OpenClawProviderConfig
  | ClaudeProviderConfig
  | ClaudeCodeProviderConfig
  | CodexProviderConfig
  | OpenAIProviderConfig;

// ============ Snapshot (server-authoritative state for clients) ============

/**
 * One row in the provider snapshot. Combines the diagnostic surface (status,
 * requirements, version) with the model list, so clients have a single
 * payload to subscribe to.
 */
export interface ProviderSnapshotEntry {
  name: string;
  /** Pretty label for UI; falls back to `name` when absent. */
  label?: string;
  status: ProviderStatus;
  isDefault: boolean;
  binaryPath?: string;
  version?: string;
  models: string[];
  requirements: ProviderRequirement[];
  lastError?: string;
  /** ISO 8601 timestamp of when this entry was last refreshed. */
  fetchedAt: string;
}

/** Full snapshot broadcast over WS / served from REST. */
export interface ProvidersSnapshot {
  providers: ProviderSnapshotEntry[];
  /** Default provider name as resolved server-side; null if none configured. */
  defaultProvider: string | null;
  /** ISO 8601 timestamp marking when this snapshot was assembled. */
  generatedAt: string;
}

/** Broadcast WS shape for snapshot updates. */
export interface WSProvidersSnapshotMessage {
  type: "providers:snapshot";
  snapshot: ProvidersSnapshot;
}
