/**
 * A provider for an endpoint somebody configured, rather than one we shipped.
 *
 * Same protocol as `openai.ts`, three differences that matter: the base URL and
 * the credential come from the endpoint record instead of from the environment,
 * every request goes through the private-network guard (the point of the
 * feature is a box on your desk, so the usual "refuse anything private" rule is
 * the wrong one here), and the context window is whatever the endpoint says it
 * is, because a local 200k model would otherwise be described by a table that
 * has never heard of it.
 *
 * Chat only. It does one completion round with no file or shell tools, which is
 * why the board's task pickers do not list it (MP-TASK-01): a card dispatched
 * on this could not read a file, let alone close itself.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  DirectEndpointProviderConfig,
  ProviderCapability,
  ProviderDiagnostic,
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
import { EndpointUrlError, fetchCheckedEndpoint } from "../lib/private-endpoint-url";
import { providerNameForEndpoint, type DirectEndpointConfig } from "../../shared/direct-endpoints";

const DEFAULT_TIMEOUT_MS = 180_000;
const MODELS_TIMEOUT_MS = 8_000;
const MODELS_TTL_MS = 30_000;
const MODELS_ERROR_TTL_MS = 5_000;
const DEFAULT_MAX_TOKENS = 4096;

interface ModelCatalog {
  status: ProviderDiagnostic["status"];
  models: string[];
  /** Windows the endpoint itself reported, per model id. */
  windows: Record<string, number>;
  lastError?: string;
}

/** An upstream refusal a user can act on, told in their own endpoint's name. */
function describeStatus(label: string, status: number): string {
  if (status === 401 || status === 403) return `${label} rejected the credentials. Check the token in Settings.`;
  if (status === 404) return `${label} has no chat completions at this address. Check the base URL in Settings.`;
  if (status === 429) return `${label} is rate limiting. Try again shortly.`;
  if (status >= 500) return `${label} returned a server error (HTTP ${status}).`;
  return `${label} refused the request (HTTP ${status}).`;
}

/**
 * A context overflow, said in a way that names the number.
 *
 * llama-server and vLLM word this differently, and both words end up in front
 * of a person who only wants to know that the conversation no longer fits.
 */
export function describeContextOverflow(
  raw: string,
  model: string,
  window: number | undefined,
): string | undefined {
  if (!/context|prompt is too long|too many tokens|exceeds/i.test(raw)) return undefined;
  if (!/exceed|too long|too large|too many|maximum/i.test(raw)) return undefined;
  return window
    ? `This conversation no longer fits the ${window.toLocaleString("en-US")} token window of ${model}. Start a new chat or shorten the context.`
    : `This conversation no longer fits the context window of ${model}. Start a new chat or shorten the context.`;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly capabilities: Set<ProviderCapability> = new Set(["streaming", "history"]);
  readonly contextStrategy = "history-aware" as const;

  private endpoint: DirectEndpointConfig;
  private token: string | undefined;
  private started = false;
  private active = new Map<string, AbortController>();
  private runIdToSessionKey = new Map<string, string>();
  private catalog: { until: number; result: ModelCatalog } | null = null;
  private pendingCatalog: Promise<ModelCatalog> | null = null;

  constructor(config: DirectEndpointProviderConfig) {
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.name = providerNameForEndpoint(config.endpoint);
  }

  /** The label the user typed, for anything that talks to a person. */
  get label(): string { return this.endpoint.label; }

  /** New requests adopt the new settings; requests already sent keep running. */
  updateConfig(config: DirectEndpointProviderConfig): void {
    const changed = config.endpoint.baseUrl !== this.endpoint.baseUrl || config.token !== this.token;
    this.endpoint = config.endpoint;
    this.token = config.token;
    if (changed) {
      this.catalog = null;
      this.pendingCatalog = null;
    }
  }

  get connected(): boolean {
    return this.started && (this.endpoint.auth !== "bearer" || Boolean(this.token));
  }

  start(): void { this.started = true; }

  stop(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.runIdToSessionKey.clear();
    this.started = false;
  }

  defaultModel(): string {
    return this.endpoint.modelFilter?.[0] ?? this.catalog?.result.models[0] ?? "";
  }

  /** The window this endpoint declares for a model, config first. */
  contextWindowFor(model: string): number | undefined {
    return this.endpoint.contextWindows?.[model] ?? this.catalog?.result.windows[model];
  }

  /** Every window this endpoint knows about, for the snapshot. */
  contextWindows(): Record<string, number> {
    return { ...(this.catalog?.result.windows ?? {}), ...(this.endpoint.contextWindows ?? {}) };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.endpoint.auth === "bearer" && this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private voice(): WireErrorVoice {
    const label = this.endpoint.label;
    return {
      invalidKey: describeStatus(label, 401),
      rateLimited: describeStatus(label, 429),
      generic: `${label} interrupted the stream. Try again shortly.`,
      incomplete: `${label} returned an event this transport could not read.`,
      truncated: `${label} ended the stream before the answer was complete.`,
    };
  }

  private timeout(): number { return this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS; }

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[]; tools?: Tool[] },
  ): Promise<{ runId?: string }> {
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    this.active.set(runId, controller);
    this.runIdToSessionKey.set(runId, sessionKey);

    const model = options?.model ?? this.defaultModel();
    const history = options?.history ?? [];
    const messages = [
      ...history.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: "user", content: message },
    ];
    // A local model with a 200k window is the reason this feature exists;
    // capping it at a small default would waste what the user configured.
    const maxTokens = Math.min(this.contextWindowFor(model) ?? DEFAULT_MAX_TOKENS, 32_768);
    const timer = setTimeout(() => controller.abort(), this.timeout());
    let fullText = "";
    let lastUsage: { promptTokens: number; completionTokens: number } | undefined;

    try {
      const response = await fetchCheckedEndpoint(`${this.endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(buildChatCompletionBody({
          model,
          messages,
          maxTokens,
          stream: true,
          includeUsage: this.endpoint.includeUsage !== false,
          tools: options?.tools && options.tools.length > 0 ? toOpenAIFunctions(options.tools) : undefined,
        })),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        const overflow = describeContextOverflow(detail, model, this.contextWindowFor(model));
        handler.onError(overflow ?? describeStatus(this.endpoint.label, response.status));
        return { runId };
      }

      await consumeChatCompletionStream(
        response.body,
        {
          onDelta: (delta) => {
            fullText += delta;
            handler.onTextDelta(delta, fullText);
          },
          onToolStart: (id, name, args) => handler.onToolStart(id, name, args),
          onUsage: (usage) => {
            lastUsage = usage;
            handler.onCallUsage?.({
              inputTokens: usage.promptTokens,
              outputTokens: usage.completionTokens,
              cacheRead: 0,
              cacheCreation: 0,
              cacheCreation1h: 0,
              model,
            });
            const window = this.contextWindowFor(model);
            handler.onContextSize?.(usage.promptTokens, model, window);
          },
        },
        this.voice(),
      );
      handler.onDone(lastUsage
        ? { usage: { inputTokens: lastUsage.promptTokens, outputTokens: lastUsage.completionTokens } }
        : undefined);
    } catch (error) {
      const err = error as { name?: string; message?: string };
      if (err?.name === "AbortError") handler.onAborted?.();
      else if (error instanceof EndpointUrlError) handler.onError(err.message ?? String(error));
      else handler.onError(err?.message ?? String(error));
    } finally {
      clearTimeout(timer);
      this.active.delete(runId);
      this.runIdToSessionKey.delete(runId);
    }

    return { runId };
  }

  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel();
    try {
      const response = await fetchCheckedEndpoint(`${this.endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(buildChatCompletionBody({
          model,
          messages: messages.map((entry) => ({ role: entry.role, content: entry.content })),
          maxTokens: DEFAULT_MAX_TOKENS,
          stream: false,
        })),
        signal: AbortSignal.timeout(this.timeout()),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const overflow = describeContextOverflow(detail, model, this.contextWindowFor(model));
        return { content: overflow ?? describeStatus(this.endpoint.label, response.status) };
      }
      const payload = readCompletionPayload(await response.json());
      return {
        content: payload.content,
        usage: payload.usage
          ? { promptTokens: payload.usage.promptTokens, completionTokens: payload.usage.completionTokens }
          : undefined,
      };
    } catch (error) {
      return { content: (error as Error).message };
    }
  }

  async abort(sessionKey: string, runId?: string): Promise<void> {
    if (runId) {
      this.active.get(runId)?.abort();
      this.active.delete(runId);
      this.runIdToSessionKey.delete(runId);
      return;
    }
    for (const [id, key] of this.runIdToSessionKey) {
      if (key !== sessionKey) continue;
      this.active.get(id)?.abort();
      this.active.delete(id);
      this.runIdToSessionKey.delete(id);
    }
  }

  async diagnose(): Promise<ProviderDiagnostic> {
    const needsToken = this.endpoint.auth === "bearer" && !this.token;
    const requirements = [{
      key: `endpoint:${this.endpoint.id}`,
      label: `${this.endpoint.label} token`,
      present: !needsToken,
      hint: needsToken ? "Add the token for this endpoint in Settings." : undefined,
    }];
    if (needsToken) return { name: this.name, status: "unavailable", requirements };
    const catalog = await this.probeModels();
    return {
      name: this.name,
      status: catalog.status,
      modelsCount: catalog.models.length,
      requirements,
      lastError: catalog.lastError,
    };
  }

  async listModels(): Promise<string[]> {
    const catalog = await this.probeModels();
    return [...catalog.models];
  }

  /** Diagnostics and the picker share one bounded, non-generating request. */
  private probeModels(): Promise<ModelCatalog> {
    if (this.catalog && Date.now() < this.catalog.until) return Promise.resolve(this.catalog.result);
    if (this.pendingCatalog) return this.pendingCatalog;
    const pending = this.fetchModels().then((result) => {
      if (this.pendingCatalog === pending) {
        this.catalog = {
          result,
          until: Date.now() + (result.status === "ready" ? MODELS_TTL_MS : MODELS_ERROR_TTL_MS),
        };
      }
      return result;
    }).finally(() => {
      if (this.pendingCatalog === pending) this.pendingCatalog = null;
    });
    this.pendingCatalog = pending;
    return pending;
  }

  private async fetchModels(): Promise<ModelCatalog> {
    const allowed = this.endpoint.modelFilter;
    try {
      const response = await fetchCheckedEndpoint(`${this.endpoint.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: response.status === 401 || response.status === 403 ? "error" : "unavailable",
          models: allowed ? [...allowed] : [],
          windows: {},
          lastError: describeStatus(this.endpoint.label, response.status),
        };
      }
      const data = asRecord(await response.json());
      if (!Array.isArray(data?.data)) throw new Error("unreadable catalog");
      const models: string[] = [];
      const windows: Record<string, number> = {};
      for (const item of data.data) {
        const record = asRecord(item);
        const id = record?.id;
        if (typeof id !== "string") continue;
        if (allowed && !allowed.includes(id)) continue;
        models.push(id);
        // llama-server reports the window it was started with; taking it from
        // the horse's mouth is the only way a 200k local model stops being
        // described by a table of hosted model names.
        const window = asRecord(record?.meta)?.n_ctx;
        if (typeof window === "number" && Number.isInteger(window) && window > 0) windows[id] = window;
      }
      return { status: "ready", models: [...new Set(models)], windows };
    } catch (error) {
      const message = error instanceof EndpointUrlError
        ? error.message
        : `${this.endpoint.label} is not answering. Check that it is running and reachable.`;
      return { status: "unavailable", models: allowed ? [...allowed] : [], windows: {}, lastError: message };
    }
  }
}
