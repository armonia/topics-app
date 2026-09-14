/**
 * Configurable OpenAI-compatible endpoints: the shape, and the rules that say
 * whether one is usable.
 *
 * Pure on purpose. The form in Settings refuses a bad endpoint before the round
 * trip, and the server refuses a hand-edited state file, and both have to say
 * the same thing about the same object: two copies of these rules would drift
 * within a release. Nothing here touches the filesystem or the network, so the
 * client can import it (the client cannot import from `server/`, TS6307).
 */

/** How a request authenticates against the endpoint. A bearer token is stored
 *  apart from the endpoint itself, so it never travels in a settings payload. */
export type DirectEndpointAuth = "none" | "bearer";

export interface DirectEndpointConfig {
  /** Stable identity of the endpoint; the provider name derives from it. */
  id: string;
  /** What the user typed, shown in the pickers. */
  label: string;
  /** Base URL of the OpenAI-compatible API, without the trailing slash. */
  baseUrl: string;
  auth: DirectEndpointAuth;
  /** When present, only these model ids are offered. */
  modelFilter?: string[];
  /** Per-request budget; absent means the transport default. */
  timeoutMs?: number;
  /** Ask for `stream_options.include_usage`. Some gateways reject the field. */
  includeUsage?: boolean;
  /** Context window per model id, when the endpoint or the user declares one. */
  contextWindows?: Record<string, number>;
}

/**
 * What a client is allowed to see about an endpoint: the config, plus whether
 * a token exists. Never the token.
 */
export interface DirectEndpointView extends DirectEndpointConfig {
  hasToken: boolean;
}

/** What a client may send. `id` absent means "a new one"; `token` is optional
 * on an update and then the stored one is kept. */
export interface DirectEndpointInput {
  id?: string;
  label: string;
  baseUrl: string;
  auth?: DirectEndpointAuth;
  token?: string;
  modelFilter?: string[];
  timeoutMs?: number;
  includeUsage?: boolean;
  contextWindows?: Record<string, number>;
}

export const DIRECT_PROVIDER_PREFIX = "direct-";
const MAX_LABEL_LENGTH = 60;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Slug of a label: lowercase, `[a-z0-9-]` and nothing else.
 *
 * No colon, and that is not cosmetic: a provider name travels inside composite
 * keys elsewhere in the app, where the colon is the separator.
 */
export function slugifyEndpointLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Provider name of an endpoint, the one the chat picker and the snapshot use. */
export function providerNameForEndpoint(endpoint: { id: string }): string {
  return `${DIRECT_PROVIDER_PREFIX}${endpoint.id}`;
}

/** True for a provider name produced by this feature. */
export function isDirectProviderName(name: string): boolean {
  return name.startsWith(DIRECT_PROVIDER_PREFIX);
}

export type ValidationResult =
  | { ok: true; value: DirectEndpointConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeBaseUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // Credentials in the URL would end up in logs and in error strings; the
  // bearer file is the one place a secret belongs.
  if (parsed.username || parsed.password) return undefined;
  if (parsed.search || parsed.hash) return undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

function normalizeContextWindows(raw: unknown): Record<string, number> | undefined | null {
  const record = asRecord(raw);
  if (!record) return null;
  const out: Record<string, number> = {};
  for (const [model, window] of Object.entries(record)) {
    if (typeof window !== "number" || !Number.isInteger(window) || window <= 0) return null;
    if (!model.trim()) return null;
    out[model] = window;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Validate anything that claims to be an endpoint: a form payload, a line of
 * the state file. The id is derived from the label when absent, so the caller
 * never has to invent one.
 */
export function validateDirectEndpoint(input: unknown): ValidationResult {
  const record = asRecord(input);
  if (!record) return { ok: false, error: "The endpoint must be an object." };

  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label) return { ok: false, error: "The endpoint needs a name." };
  if (label.length > MAX_LABEL_LENGTH) return { ok: false, error: "The name is too long." };

  const rawId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : label;
  const id = slugifyEndpointLabel(rawId);
  if (!id) return { ok: false, error: "The name must contain a letter or a digit." };

  const rawUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (!rawUrl) return { ok: false, error: "The endpoint needs a base URL." };
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) return { ok: false, error: "The base URL must be a plain http or https address." };

  const auth = record.auth === undefined ? "none" : record.auth;
  if (auth !== "none" && auth !== "bearer") return { ok: false, error: "Unknown authentication mode." };

  let modelFilter: string[] | undefined;
  if (record.modelFilter !== undefined) {
    if (!Array.isArray(record.modelFilter)) return { ok: false, error: "The model list must be an array." };
    const models = record.modelFilter
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (models.length !== record.modelFilter.length) return { ok: false, error: "Model ids must be non-empty text." };
    modelFilter = models.length ? models : undefined;
  }

  let timeoutMs: number | undefined;
  if (record.timeoutMs !== undefined && record.timeoutMs !== null) {
    const value = record.timeoutMs;
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
      return { ok: false, error: `The timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.` };
    }
    timeoutMs = value;
  }

  let contextWindows: Record<string, number> | undefined;
  if (record.contextWindows !== undefined && record.contextWindows !== null) {
    const parsed = normalizeContextWindows(record.contextWindows);
    if (parsed === null) return { ok: false, error: "Each context window must be a positive whole number of tokens." };
    contextWindows = parsed;
  }

  const includeUsage = record.includeUsage === undefined ? true : record.includeUsage === true;

  return {
    ok: true,
    value: { id, label, baseUrl, auth, modelFilter, timeoutMs, includeUsage, contextWindows },
  };
}
