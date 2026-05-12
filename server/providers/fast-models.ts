// server/providers/fast-models.ts
//
// Maps each provider name to its "fast" model id — the cheapest/lowest-latency
// model the provider supports. Used by the `/api/chat` route handler when the
// client requests `fastMode: true` AND no explicit model override is set.
//
// Adding a new provider? Add an entry below. Use `null` if the provider has no
// distinct fast model (e.g. a gateway routes internally based on the request
// shape — the route handler will skip the override and let the gateway decide).

export const FAST_MODELS: Record<string, string | null> = {
  // claude-code CLI accepts `--model haiku` (alias resolved by the binary at
  // runtime). The canonical id is what the CLI reports back in stream events
  // and what `claude-code.ts:listModels()` advertises.
  "claude-code": "claude-haiku-4-5",

  // Anthropic SDK — KNOWN_MODELS in `claude.ts` lists the short alias
  // ("claude-haiku-4-5"), which the API accepts as a routing alias to the
  // latest dated haiku. We use the short form here so the snapshot guard
  // doesn't drop the override on a string mismatch.
  "claude": "claude-haiku-4-5",

  // Codex CLI's available models live in $CODEX_HOME/models_cache.json and
  // currently surface gpt-5.5 / gpt-5.4 / gpt-5.4-mini / … The "mini" tier is
  // the fast/cheap choice. If your codex cache is older or the slug changes,
  // the heuristic fallback below (look for "mini") still picks the right model.
  "codex": "gpt-5.4-mini",

  // OpenAI SDK direct. gpt-4o-mini is the standard fast/cheap chat model.
  "openai": "gpt-4o-mini",

  // OpenClaw gateway routes internally based on payload — no per-request fast
  // model selection from our side. Returning `null` tells the route handler to
  // NOT override the model and to let the gateway decide. We log an info event
  // when fast mode is requested for openclaw so users know the request was
  // delegated rather than ignored.
  "openclaw": null,
};

/**
 * Heuristic fallback used when the statically-mapped fast model is not in the
 * provider snapshot's `models[]` list. Looks for "haiku" first (Anthropic
 * naming), then "mini" (OpenAI / Codex naming), then "flash" (future-proofing
 * for Gemini-style providers).
 *
 * Pure function — `availableModels` is the live `snap.providers[i].models`.
 * Returns the first match (provider lists are ordered: preferred first, but
 * "fast tier" naming is unambiguous enough that ordering doesn't matter much).
 *
 * Returns `null` when no heuristic matches; caller falls back to provider
 * default and logs a warning. This avoids guessing wildly different model
 * tiers under the "fast" label.
 */
export function findFastModelHeuristic(availableModels: readonly string[]): string | null {
  if (!availableModels.length) return null;
  // Word-boundary match: the needle must be its own token in the model id.
  // Naive `.includes()` was wrong — e.g. "gemini" contains "mini" as a
  // substring, which would mis-classify Gemini Pro as a fast model. We split
  // on non-alphanumerics (which covers `-`, `.`, `/`, `_`, spaces) so e.g.
  // "gpt-5.4-mini" → ["gpt", "5", "4", "mini"] and matches needle "mini",
  // while "gemini-2.0-pro" → ["gemini", "2", "0", "pro"] does not.
  const tokenized = availableModels.map((m) => ({
    id: m,
    tokens: new Set(m.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
  }));
  // Priority order: haiku > mini > flash. First match wins.
  for (const needle of ["haiku", "mini", "flash"]) {
    const hit = tokenized.find((e) => e.tokens.has(needle));
    if (hit) return hit.id;
  }
  return null;
}

/**
 * Returns the fast-model id for a provider, or `null` if the provider has no
 * distinct fast model (gateway-style providers) or is unknown.
 *
 * Case-insensitive lookup — provider names are normalized to lowercase before
 * lookup, so callers can pass `provider.name` directly without worrying about
 * registration casing.
 *
 * When `availableModels` is supplied AND the statically-mapped id is NOT in
 * the list, we fall back to `findFastModelHeuristic(availableModels)`. This
 * keeps the helper resilient across CLI/SDK version bumps that rename slugs
 * (e.g. codex going from gpt-4o-mini → gpt-5.4-mini → ...) — the operator
 * doesn't have to chase the mapping table to keep fast mode working.
 */
export function getFastModelFor(name: string, availableModels?: readonly string[]): string | null {
  if (!name) return null;
  const key = name.toLowerCase();
  // `Object.prototype.hasOwnProperty.call` so a provider named "toString" or
  // "constructor" doesn't accidentally match an inherited property.
  if (!Object.prototype.hasOwnProperty.call(FAST_MODELS, key)) return null;
  const mapped = FAST_MODELS[key];
  // null mapping (e.g. openclaw) → keep null. Static mapping is intentional.
  if (mapped === null) return null;
  // No snapshot to consult — trust the static mapping.
  if (!availableModels || availableModels.length === 0) return mapped;
  // Static mapping matches a live model → done.
  if (availableModels.includes(mapped)) return mapped;
  // Static mapping is stale; heuristic search.
  return findFastModelHeuristic(availableModels);
}
