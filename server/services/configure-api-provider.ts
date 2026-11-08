import type { ClaudeProviderConfig, OpenAIProviderConfig, ProviderDiagnostic } from "../providers/types";
import { saveApiProviderKey, type ApiProviderName } from "./api-provider-credentials";

export class ApiConnectionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

type ApiConfig = ClaudeProviderConfig | OpenAIProviderConfig;

export function parseApiConfig(name: ApiProviderName, body: unknown): ApiConfig {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiConnectionError("api_config_invalid", "Invalid provider configuration.");
  const { apiKey, model, maxTokens } = body as Record<string, unknown>;
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8192 || /\s/.test(apiKey.trim())) {
    throw new ApiConnectionError("api_config_invalid", "Enter a valid API key.");
  }
  if (model != null && (typeof model !== "string" || model.length > 200 || /\s/.test(model.trim()))) {
    throw new ApiConnectionError("api_config_invalid", "Invalid model.");
  }
  const tokens = maxTokens == null ? undefined : Number(maxTokens);
  if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0)) throw new ApiConnectionError("api_config_invalid", "Invalid token limit.");
  return { type: name, apiKey: apiKey.trim(), model: typeof model === "string" ? model.trim() || undefined : undefined, maxTokens: tokens };
}

/** A rejected key must never replace the working one. Validation uses /models,
 * not a generation; storing or replacing it does not spend inference credit. */
export async function configureApiProvider(
  config: ApiConfig,
  deps: {
    diagnose: (config: ApiConfig) => Promise<ProviderDiagnostic>;
    apply: (config: ApiConfig) => void;
    save?: typeof saveApiProviderKey;
  },
): Promise<void> {
  let diagnostic: ProviderDiagnostic;
  try { diagnostic = await deps.diagnose(config); }
  catch { throw new ApiConnectionError("api_unreachable", "Provider connection failed. Try again shortly."); }
  if (diagnostic.status !== "ready") {
    // Upstream bodies may echo credentials; only our own fixed errors escape.
    throw new ApiConnectionError(diagnostic.status === "error" ? "api_key_rejected" : "api_unreachable", diagnostic.status === "error"
      ? "API key rejected. Check the key and provider permissions."
      : "Provider is unreachable. Check the connection and try again.");
  }
  (deps.save ?? saveApiProviderKey)(config.type, config.apiKey);
  deps.apply(config);
}
