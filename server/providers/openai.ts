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
import {
  asRecord,
  buildChatCompletionBody,
  consumeChatCompletionStream,
  readCompletionPayload,
  type WireErrorVoice,
} from "./openai-wire";
import { resolveOpenaiMaxTokens, resolveOpenaiModel } from "../services/app-settings";

const API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_TOKENS = 8192;
const MODELS_TTL_MS = 30_000;
const MODELS_ERROR_TTL_MS = 5_000;

interface ModelsProbe {
  status: ProviderDiagnostic["status"];
  models: string[];
  lastError?: string;
}

/** This transport serves text Chat Completions, not specialized Responses models. */
function isChatModel(id: string): boolean {
  return /^(gpt-|o\d)/.test(id)
    && !/(?:^|-)(?:image|audio|realtime|transcribe|transcription|tts|codex|deep-research|pro|instruct)(?:-|$)/.test(id);
}

const FALLBACK_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "o3-mini",
];

function sanitizeUpstreamError(status: number): string {
  if (status === 401 || status === 403) return "OpenAI auth failed. Check your API key in Settings.";
  if (status === 429) return "OpenAI rate limit reached. Try again shortly.";
  if (status >= 500) return `OpenAI service error (HTTP ${status})`;
  return `OpenAI request failed (HTTP ${status})`;
}

/** How this provider words an upstream stream failure. */
const ERROR_VOICE: WireErrorVoice = {
  invalidKey: sanitizeUpstreamError(401),
  rateLimited: sanitizeUpstreamError(429),
  generic: "OpenAI stream failed. Try again shortly.",
  incomplete: "OpenAI returned an incomplete stream event.",
  truncated: "OpenAI stream ended before the response completed.",
};

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  readonly capabilities: Set<ProviderCapability> = new Set(["streaming", "history"]);
  // Stateless OpenAI HTTP — system messages and prior turns flow via
  // `options.history` (mapped to OpenAI message format internally).
  readonly contextStrategy = "history-aware" as const;

  private config: OpenAIProviderConfig;
  private active = new Map<string, AbortController>();
  // runId -> sessionKey, so abort(sessionKey) without a runId stops ONLY that
  // session's runs (not every session's — see ClaudeProvider for the rationale).
  private runIdToSessionKey = new Map<string, string>();
  private started = false;
  private cachedModels: { until: number; result: ModelsProbe } | null = null;
  private modelsProbe: Promise<ModelsProbe> | null = null;

  constructor(config: OpenAIProviderConfig) {
    this.config = { ...config };
  }

  /** New requests adopt the new key; requests already sent keep running. */
  updateConfig(config: OpenAIProviderConfig): void {
    if (config.apiKey !== this.config.apiKey) {
      this.cachedModels = null;
      this.modelsProbe = null;
    }
    this.config = { ...config };
  }

  defaultModel(): string {
    return resolveOpenaiModel() ?? this.config.model ?? DEFAULT_MODEL;
  }

  private maxTokens(): number {
    const value = resolveOpenaiMaxTokens() ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS;
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
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
    this.runIdToSessionKey.clear();
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
    this.runIdToSessionKey.set(runId, sessionKey);

    const model = options?.model ?? this.defaultModel();
    const maxTokens = this.maxTokens();

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
      // Phase 30 BROWSER-CHAT-04 - Anthropic Tool[] travel in OpenAI
      // function-calling format; tool_choice='auto' lets the model decide
      // if and when to call any of the registered tools.
      const body = buildChatCompletionBody({
        model,
        messages: apiMessages,
        maxTokens,
        stream: true,
        tools: options?.tools && options.tools.length > 0 ? toOpenAIFunctions(options.tools) : undefined,
      });

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

      await consumeChatCompletionStream(
        resp.body,
        {
          onDelta: (delta) => {
            fullText += delta;
            handler.onTextDelta(delta, fullText);
          },
          onToolStart: (id, name, args) => handler.onToolStart(id, name, args),
        },
        ERROR_VOICE,
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
      this.runIdToSessionKey.delete(runId);
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
    const model = this.defaultModel();
    const maxTokens = this.maxTokens();

    const upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionBody({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens,
        stream: true,
      })),
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

  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    if (!this.config.apiKey) {
      return { content: "OPENAI_API_KEY not configured" };
    }
    const model = options?.model ?? this.defaultModel();
    const maxTokens = this.maxTokens();

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionBody({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens,
        stream: false,
      })),
    });

    if (!resp.ok) {
      await resp.text().catch(() => "");
      return { content: sanitizeUpstreamError(resp.status) };
    }

    return readCompletionPayload(await resp.json());
  }

  // --- Abort ---

  async abort(sessionKey: string, runId?: string): Promise<void> {
    if (runId) {
      this.active.get(runId)?.abort();
      this.active.delete(runId);
      this.runIdToSessionKey.delete(runId);
    } else {
      // No runId: abort ONLY this session's in-flight runs.
      for (const [rid, sk] of this.runIdToSessionKey) {
        if (sk !== sessionKey) continue;
        this.active.get(rid)?.abort();
        this.active.delete(rid);
        this.runIdToSessionKey.delete(rid);
      }
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

    const probe = await this.probeModels();
    return {
      name: this.name,
      status: probe.status,
      modelsCount: probe.models.length,
      requirements,
      lastError: probe.lastError,
    };
  }

  async listModels(): Promise<string[]> {
    if (!this.config.apiKey) return [...FALLBACK_MODELS];
    const probe = await this.probeModels();
    return [...(probe.status === "ready" ? probe.models : FALLBACK_MODELS)];
  }

  /** Diagnostics and the picker share one bounded, non-generating request. */
  private probeModels(): Promise<ModelsProbe> {
    if (this.cachedModels && Date.now() < this.cachedModels.until) {
      return Promise.resolve(this.cachedModels.result);
    }
    if (this.modelsProbe) return this.modelsProbe;
    const pending = this.fetchModels(this.config.apiKey).then((result) => {
      // A reply using a replaced key cannot populate the new key's cache.
      if (this.modelsProbe === pending) this.cachedModels = {
        result, until: Date.now() + (result.status === "ready" ? MODELS_TTL_MS : MODELS_ERROR_TTL_MS),
      };
      return result;
    }).finally(() => {
      if (this.modelsProbe === pending) this.modelsProbe = null;
    });
    this.modelsProbe = pending;
    return pending;
  }

  private async fetchModels(apiKey: string): Promise<ModelsProbe> {
    try {
      const resp = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        await resp.body?.cancel();
        return {
          status: resp.status === 401 || resp.status === 403 ? "error" : "unavailable",
          models: [], lastError: sanitizeUpstreamError(resp.status),
        };
      }
      const data = asRecord(await resp.json());
      if (!Array.isArray(data?.data)) throw new Error("Invalid models response");
      const models = data.data.map((item: unknown) => asRecord(item)?.id)
        .filter((id): id is string => typeof id === "string" && isChatModel(id));
      return { status: "ready", models: [...new Set(models)].sort() };
    } catch {
      return { status: "unavailable", models: [], lastError: "OpenAI model catalog is unavailable. Try again shortly." };
    }
  }
}
