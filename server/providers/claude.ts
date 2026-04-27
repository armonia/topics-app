/**
 * ClaudeProvider — AIProvider implementation using the Anthropic SDK directly.
 *
 * Standalone mode: no OpenClaw Gateway, no WebSocket sessions, no tools.
 * Talks to the Anthropic API for streaming chat, HTTP SSE, and completions.
 */

import Anthropic from "@anthropic-ai/sdk";
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

// Models that support extended thinking (claude-3-7 and later)
const THINKING_MODELS = /^claude-(3-7|4|sonnet-4|opus-4)/;

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_THINKING_BUDGET = 10_000;

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  readonly capabilities: Set<ProviderCapability> = new Set(["streaming", "thinking"]);

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
    options?: { model?: string },
  ): Promise<{ runId?: string }> {
    const client = this.requireClient();
    const runId = crypto.randomUUID();
    const abortController = new AbortController();
    this.activeAbortControllers.set(runId, abortController);

    const model = options?.model ?? this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: message }],
    };

    if (this.supportsThinking(model)) {
      params.thinking = { type: "enabled", budget_tokens: DEFAULT_THINKING_BUDGET };
    }

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

    if (this.supportsThinking(model)) {
      params.thinking = { type: "enabled", budget_tokens: DEFAULT_THINKING_BUDGET };
    }

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
    return [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-20250514",
    ];
  }

  // --- Internals ---

  private requireClient(): Anthropic {
    if (!this.client) {
      throw new Error("ClaudeProvider not started — call start() first");
    }
    return this.client;
  }

  private supportsThinking(model: string): boolean {
    return THINKING_MODELS.test(model);
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
