/**
 * OpenAIProvider — direct HTTP wrapper for the OpenAI Chat Completions API.
 *
 * No SDK dependency: uses fetch + SSE parsing. Auto-initialized when
 * OPENAI_API_KEY is present in the environment, or configured at runtime via
 * the Settings UI.
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  OpenAIProviderConfig,
  ProviderCapability,
  ProviderDiagnostic,
  ProviderRequirement,
  StreamHandler,
} from "./types";
import { toOpenAIFunctions } from "../browser-tools-adapters";

const API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_TOKENS = 8192;

const FALLBACK_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "o3-mini",
];

function sanitizeUpstreamError(status: number): string {
  if (status === 401 || status === 403) return "OpenAI auth failed — check your API key in Settings.";
  if (status === 429) return "OpenAI rate limit reached — try again shortly.";
  if (status >= 500) return `OpenAI service error (HTTP ${status})`;
  return `OpenAI request failed (HTTP ${status})`;
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  readonly capabilities: Set<ProviderCapability> = new Set(["streaming", "history"]);

  private config: OpenAIProviderConfig;
  private active = new Map<string, AbortController>();
  private started = false;
  private cachedModels: string[] | null = null;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.started && Boolean(this.config.apiKey);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    for (const c of this.active.values()) c.abort();
    this.active.clear();
    this.started = false;
  }

  // --- Streaming chat ---

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[]; tools?: Tool[] },
  ): Promise<{ runId?: string }> {
    if (!this.config.apiKey) {
      handler.onError("OPENAI_API_KEY not configured");
      return { runId: undefined };
    }

    const runId = crypto.randomUUID();
    const ac = new AbortController();
    this.active.set(runId, ac);

    const model = options?.model ?? this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Stateless API — must resend full conversation every turn. `history`
    // contains every prior turn (system + user + assistant); we append the
    // new user message at the end.
    const history = options?.history ?? [];
    const apiMessages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    let fullText = "";

    try {
      const body: Record<string, unknown> = {
        model,
        messages: apiMessages,
        max_tokens: maxTokens,
        stream: true,
      };

      // Phase 30 BROWSER-CHAT-04 — wrap Anthropic Tool[] into OpenAI
      // function-calling format and forward. tool_choice='auto' lets the
      // model decide if/when to call any of the registered tools.
      if (options?.tools && options.tools.length > 0) {
        body.tools = toOpenAIFunctions(options.tools);
        body.tool_choice = "auto";
      }

      const resp = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!resp.ok || !resp.body) {
        await resp.text().catch(() => "");
        handler.onError(sanitizeUpstreamError(resp.status));
        return { runId };
      }

      await this.consumeSSE(
        resp.body,
        (delta) => {
          fullText += delta;
          handler.onTextDelta(delta, fullText);
        },
        (id, name, args) => handler.onToolStart(id, name, args),
      );

      handler.onDone();
    } catch (err: any) {
      if (err?.name === "AbortError") {
        handler.onAborted?.();
      } else {
        handler.onError(err?.message ?? String(err));
      }
    } finally {
      this.active.delete(runId);
    }

    return { runId };
  }

  // --- HTTP SSE proxy (already OpenAI format — passthrough) ---

  async streamHTTP(
    messages: ChatMessage[],
    options?: { sessionKey?: string; signal?: AbortSignal },
  ): Promise<Response> {
    if (!this.config.apiKey) {
      return new Response(
        `data: ${JSON.stringify({ error: { message: "OPENAI_API_KEY not configured" } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    const model = this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!upstream.ok || !upstream.body) {
      await upstream.text().catch(() => "");
      const errMsg = sanitizeUpstreamError(upstream.status);
      const body =
        `data: ${JSON.stringify({ error: { message: errMsg } })}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // --- Non-streaming completion ---

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    if (!this.config.apiKey) {
      return { content: "OPENAI_API_KEY not configured" };
    }
    const model = this.config.model ?? DEFAULT_MODEL;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
      }),
    });

    if (!resp.ok) {
      await resp.text().catch(() => "");
      return { content: sanitizeUpstreamError(resp.status) };
    }

    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage;
    return {
      content,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      } : undefined,
    };
  }

  // --- Abort ---

  async abort(_sessionKey: string, runId?: string): Promise<void> {
    if (runId) {
      this.active.get(runId)?.abort();
      this.active.delete(runId);
    } else {
      for (const c of this.active.values()) c.abort();
      this.active.clear();
    }
  }

  // --- Diagnostics ---

  async diagnose(): Promise<ProviderDiagnostic> {
    const requirements: ProviderRequirement[] = [];

    const hasKey = Boolean(this.config.apiKey);
    requirements.push({
      key: "OPENAI_API_KEY",
      label: "OpenAI API key",
      present: hasKey,
      hint: hasKey ? undefined : "Set OPENAI_API_KEY in your environment, or configure in Settings.",
    });

    if (!hasKey) {
      return { name: this.name, status: "unavailable", requirements };
    }

    // Live ping: fetch /v1/models with a short timeout
    let lastError: string | undefined;
    let modelsCount = 0;
    let status: ProviderDiagnostic["status"] = "ready";
    try {
      const resp = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        modelsCount = Array.isArray(data?.data) ? data.data.length : 0;
      } else if (resp.status === 401 || resp.status === 403) {
        // Key set but rejected — real misconfiguration.
        status = "error";
        lastError = `Auth failed (HTTP ${resp.status})`;
      } else {
        // Transient HTTP / network — surface as unavailable, not an error badge.
        status = "unavailable";
        lastError = `HTTP ${resp.status}`;
      }
    } catch (err: any) {
      status = "unavailable";
      lastError = err?.message ?? "Network error";
    }

    return {
      name: this.name,
      status,
      modelsCount,
      requirements,
      lastError,
    };
  }

  async listModels(): Promise<string[]> {
    if (this.cachedModels) return this.cachedModels;
    if (!this.config.apiKey) return FALLBACK_MODELS;

    try {
      const resp = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return FALLBACK_MODELS;
      const data: any = await resp.json();
      const ids: string[] = Array.isArray(data?.data)
        ? data.data.map((m: any) => m.id).filter(Boolean)
        : [];
      // Filter to chat-capable models (gpt-* and o*-*)
      const filtered = ids.filter((id) => /^(gpt-|o\d)/.test(id)).sort();
      this.cachedModels = filtered.length > 0 ? filtered : FALLBACK_MODELS;
      return this.cachedModels;
    } catch {
      return FALLBACK_MODELS;
    }
  }

  // --- Internals ---

  private async consumeSSE(
    body: ReadableStream<Uint8Array>,
    onDelta: (text: string) => void,
    onToolStart?: (toolCallId: string, name: string, args: Record<string, unknown>) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Phase 30 BROWSER-CHAT-04 — accumulate per-index tool_call deltas. OpenAI
    // streams function calls in pieces:
    //   { delta: { tool_calls: [{ index, id?, function: { name?, arguments } }] }}
    // We collect them and emit handler.onToolStart on `finish_reason === 'tool_calls'`.
    const toolCalls: Record<number, { id: string; name: string; args: string }> = {};

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep last partial

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const event = JSON.parse(payload);
            const delta = event?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              onDelta(delta);
            }
            // Tool call streaming: accumulate per-index and emit on finish.
            const tcArr = event?.choices?.[0]?.delta?.tool_calls;
            if (Array.isArray(tcArr) && onToolStart) {
              for (const tc of tcArr) {
                const idx = typeof tc?.index === "number" ? tc.index : 0;
                if (tc?.id && tc?.function?.name) {
                  toolCalls[idx] = { id: tc.id, name: tc.function.name, args: "" };
                }
                if (tc?.function?.arguments && toolCalls[idx]) {
                  toolCalls[idx].args += tc.function.arguments;
                }
              }
            }
            const finishReason = event?.choices?.[0]?.finish_reason;
            if (finishReason === "tool_calls" && onToolStart) {
              for (const tc of Object.values(toolCalls)) {
                let parsed: Record<string, unknown> = {};
                try {
                  parsed = tc.args ? JSON.parse(tc.args) : {};
                } catch {
                  parsed = { _raw: tc.args };
                }
                onToolStart(tc.id, tc.name, parsed);
              }
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}
