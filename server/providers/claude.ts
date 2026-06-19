/**
 * ClaudeProvider — AIProvider implementation using the Anthropic SDK directly.
 *
 * Standalone mode: no OpenClaw Gateway, no WebSocket sessions, no tools.
 * Talks to the Anthropic API for streaming chat, HTTP SSE, and completions.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type {
  AIProvider,
  ChatMessage,
  ClaudeProviderConfig,
  CompletionResult,
  ProviderCapability,
  ProviderDiagnostic,
  ProviderRequirement,
  StreamHandler,
} from "./types";

// Model families that support extended thinking. Claude 3.7 + all Claude 4.x.
const THINKING_MODELS = /^claude-(3-7|sonnet-4|opus-4|haiku-4)/;

// Models that REQUIRE adaptive thinking (Opus 4.7+ removed budget_tokens entirely).
// budget_tokens returns 400 on Opus 4.7. On 4.6 it's deprecated but still works.
// We use adaptive on every 4.6+ alias to match Anthropic's recommended path.
const ADAPTIVE_THINKING_MODELS = /^claude-(opus-4-(?:6|7)|sonnet-4-6|haiku-4-5)/;

const DEFAULT_MODEL = "claude-sonnet-4-6";
// Output ceiling. Must always exceed any thinking budget we send (legacy
// `budget_tokens` < `max_tokens` is a hard API constraint on pre-4.6 models).
const DEFAULT_MAX_TOKENS = 16384;
// Legacy fixed budget — only used for pre-4.6 models that don't accept adaptive.
// Kept strictly below DEFAULT_MAX_TOKENS to avoid the "budget >= max" 400.
const LEGACY_THINKING_BUDGET = 8000;

// Public model aliases that resolve to actual Anthropic API models. Order
// matters: the first entry is what the picker shows first when this provider
// is the default. Sonnet 4.6 leads because it's the recommended balanced choice.
const KNOWN_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
];

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  readonly capabilities: Set<ProviderCapability> = new Set(["streaming", "thinking", "history"]);
  // Stateless Anthropic SDK call — system messages and prior turns flow via
  // `options.history`. See `server/context/adapt.ts`.
  readonly contextStrategy = "history-aware" as const;

  private client: Anthropic | null = null;
  private config: ClaudeProviderConfig;
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(config: ClaudeProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  // --- Lifecycle ---

  start(): void {
    this.client = new Anthropic({ apiKey: this.config.apiKey });
  }

  stop(): void {
    // Abort all in-flight requests
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
    this.client = null;
  }

  // --- Streaming Chat ---

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[]; tools?: Tool[] },
  ): Promise<{ runId?: string }> {
    const client = this.requireClient();
    const runId = crypto.randomUUID();
    const abortController = new AbortController();
    this.activeAbortControllers.set(runId, abortController);

    const model = options?.model ?? this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Build the full message array. Anthropic API is stateless — we MUST
    // resend the entire conversation history every turn. Without `history`
    // every call starts a fresh conversation (the long-standing bug).
    const { system, conversationMessages } = this.splitSystemMessage(options?.history ?? []);
    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: [
        ...conversationMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user", content: message },
      ],
    };
    if (system) params.system = system;

    this.applyThinking(params, model, maxTokens);

    // Phase 30 BROWSER-CHAT-04 — passthrough Tool[] when caller registered them.
    // Anthropic SDK natively accepts MessageCreateParams.tools as Tool[].
    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools;
    }

    // LIMITATION (Phase 30): single-turn tool emission only. Multi-turn
    // tool_use -> tool_result -> next-turn loop is deferred (would require
    // restarting the stream after handler.onToolResult fires). The existing
    // topics.ts onToolStart hook is sufficient for v1: the tool runs,
    // broadcasts, and persists, but the LLM does not see the result back in
    // the same conversation turn.

    // Per-block-index buffers for tool_use streaming (input_json_delta accumulates JSON).
    const toolJsonBuffers: Record<number, string> = {};
    const toolBlocksByIndex: Record<number, { id: string; name: string }> = {};

    let fullText = "";

    try {
      const stream = client.messages.stream(params, {
        signal: abortController.signal,
      });

      for await (const event of stream) {
        if (abortController.signal.aborted) {
          handler.onAborted?.();
          break;
        }

        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            fullText += event.delta.text;
            handler.onTextDelta(event.delta.text, fullText);
          } else if (event.delta.type === "thinking_delta") {
            handler.onThinkingDelta?.(event.delta.thinking);
          } else if (event.delta.type === "input_json_delta") {
            // Buffer per-block; finalize on content_block_stop. Each tool_use
            // block accumulates JSON in pieces.
            const idx = event.index ?? 0;
            toolJsonBuffers[idx] = (toolJsonBuffers[idx] || "") + event.delta.partial_json;
          }
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          const idx = event.index ?? 0;
          toolBlocksByIndex[idx] = {
            id: event.content_block.id,
            name: event.content_block.name,
          };
          // Initialize buffer so input_json_delta accumulation can start.
          toolJsonBuffers[idx] = "";
        } else if (event.type === "content_block_stop") {
          const idx = event.index ?? 0;
          const tb = toolBlocksByIndex[idx];
          if (tb && toolJsonBuffers[idx] !== undefined) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = toolJsonBuffers[idx] ? JSON.parse(toolJsonBuffers[idx]) : {};
            } catch {
              parsed = { _raw: toolJsonBuffers[idx] };
            }
            // Emit tool_start with full args so the topics.ts dispatcher can
            // act on them (single-emit pattern -- the dispatcher only needs
            // the final args, never the partial JSON).
            handler.onToolStart(tb.id, tb.name, parsed);
            delete toolBlocksByIndex[idx];
            delete toolJsonBuffers[idx];
          }
        } else if (event.type === "message_stop") {
          handler.onDone();
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        handler.onAborted?.();
      } else {
        handler.onError(err?.message ?? String(err));
      }
    } finally {
      this.activeAbortControllers.delete(runId);
    }

    return { runId };
  }

  // --- HTTP Streaming (SSE in OpenAI-compatible format) ---

  async streamHTTP(
    messages: ChatMessage[],
    options?: { sessionKey?: string; signal?: AbortSignal }
  ): Promise<Response> {
    const client = this.requireClient();
    const model = this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Separate system message from conversation messages
    const { system, conversationMessages } = this.splitSystemMessage(messages);

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: conversationMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    };

    if (system) {
      params.system = system;
    }

    this.applyThinking(params, model, maxTokens);

    const anthropicStream = client.messages.stream(params, {
      signal: options?.signal,
    });

    // Transform Anthropic stream events into OpenAI-compatible SSE
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of anthropicStream) {
            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                const chunk = {
                  choices: [
                    {
                      index: 0,
                      delta: { content: event.delta.text },
                    },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              // Thinking deltas are not part of OpenAI format — skip in SSE
            } else if (event.type === "message_stop") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          }
        } catch (err: any) {
          if (err?.name !== "AbortError") {
            const errorChunk = {
              error: { message: err?.message ?? String(err) },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // --- Non-streaming Completion ---

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    const client = this.requireClient();
    const model = this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const { system, conversationMessages } = this.splitSystemMessage(messages);

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: conversationMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    };

    if (system) {
      params.system = system;
    }

    const response = await client.messages.create(params);

    // Extract text from content blocks
    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      content,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  }

  // --- Abort ---

  async abort(_sessionKey: string, runId?: string): Promise<void> {
    if (runId) {
      const controller = this.activeAbortControllers.get(runId);
      if (controller) {
        controller.abort();
        this.activeAbortControllers.delete(runId);
      }
    } else {
      // Abort all
      for (const controller of this.activeAbortControllers.values()) {
        controller.abort();
      }
      this.activeAbortControllers.clear();
    }
  }

  // --- Diagnostics ---

  async diagnose(): Promise<ProviderDiagnostic> {
    const requirements: ProviderRequirement[] = [{
      key: "ANTHROPIC_API_KEY",
      label: "Anthropic API key",
      present: Boolean(this.config.apiKey),
      hint: this.config.apiKey ? undefined : "Set ANTHROPIC_API_KEY in env, or configure in Settings.",
    }];

    if (!this.config.apiKey) {
      return { name: this.name, status: "unavailable", requirements };
    }

    let status: ProviderDiagnostic["status"] = "ready";
    let lastError: string | undefined;
    let modelsCount = 0;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        modelsCount = Array.isArray(data?.data) ? data.data.length : 0;
      } else if (resp.status === 401 || resp.status === 403) {
        // Key is set but rejected — that's a real misconfiguration.
        status = "error";
        lastError = `Auth failed (HTTP ${resp.status})`;
      } else {
        // Other HTTP failures or network issues = transient; treat as unavailable
        // so the user isn't startled by red badges for a hiccup.
        status = "unavailable";
        lastError = `HTTP ${resp.status}`;
      }
    } catch (err: any) {
      status = "unavailable";
      lastError = err?.message ?? "Network error";
    }

    return { name: this.name, status, modelsCount, requirements, lastError };
  }

  async listModels(): Promise<string[]> {
    // Try to fetch live model list from the API. Filter to chat-capable
    // Claude models (drop embeddings, etc. — none currently exist but the
    // filter is cheap insurance). Falls back to the known-good list.
    if (!this.config.apiKey) return KNOWN_MODELS;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return KNOWN_MODELS;
      const data: any = await resp.json();
      const ids: string[] = Array.isArray(data?.data)
        ? data.data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string")
        : [];
      // Keep only Claude chat models. The API returns aliases AND date-suffixed
      // IDs; we surface aliases-only when available so the picker stays clean.
      const aliases = ids.filter((id) => /^claude-(opus|sonnet|haiku)-\d+(?:-\d+)?$/.test(id));
      return aliases.length > 0 ? aliases : ids.filter((id) => id.startsWith("claude-"));
    } catch {
      return KNOWN_MODELS;
    }
  }

  // --- Internals ---

  private requireClient(): Anthropic {
    if (!this.client) {
      throw new Error("ClaudeProvider not started — call start() first");
    }
    return this.client;
  }

  /**
   * Apply the right thinking config for the requested model.
   *
   * - Opus 4.7 / Opus 4.6 / Sonnet 4.6 / Haiku 4.5: adaptive thinking. The
   *   model decides when and how much to think. `budget_tokens` is removed on
   *   4.7 and deprecated on 4.6, so adaptive is the only safe default.
   * - Older Claude 4 / Sonnet 3.7: legacy `enabled` thinking with a fixed
   *   budget that is always strictly less than `max_tokens` (else 400).
   * - Anything else: no thinking config (Haiku 3.x etc).
   */
  private applyThinking(params: Anthropic.MessageCreateParams, model: string, maxTokens: number): void {
    if (ADAPTIVE_THINKING_MODELS.test(model)) {
      params.thinking = { type: "adaptive" } as any;
      return;
    }
    if (THINKING_MODELS.test(model)) {
      // Cap budget below max_tokens with a comfortable margin — the API
      // requires strictly less, and we want headroom for the actual response.
      const budget = Math.min(LEGACY_THINKING_BUDGET, Math.max(1024, Math.floor(maxTokens * 0.5)));
      if (budget >= maxTokens) {
        // Pathological config (caller passed maxTokens <= 1024). Skip thinking
        // rather than error — better to lose reasoning than hard-fail.
        return;
      }
      params.thinking = { type: "enabled", budget_tokens: budget };
    }
  }

  /**
   * Split system messages from conversation messages.
   * Anthropic API takes system as a top-level param, not in the messages array.
   */
  private splitSystemMessage(messages: ChatMessage[]): {
    system: string | undefined;
    conversationMessages: ChatMessage[];
  } {
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");

    const system = systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join("\n\n")
      : undefined;

    return { system, conversationMessages };
  }
}
