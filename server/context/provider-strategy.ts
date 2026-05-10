/**
 * Provider strategy resolver.
 *
 * Single helper used by:
 *   - `assembleTopicContext` to populate `envelope.providerStrategy`
 *   - `adaptEnvelope` to switch on the strategy
 *
 * Providers SHOULD declare `contextStrategy` explicitly on their class.
 * This helper exists for backwards compatibility: if a provider does not
 * declare it (e.g. a legacy or third-party implementation), we derive it
 * from `capabilities.has("history")`.
 */

import type { AIProvider, ProviderContextStrategy } from "../providers/types";

/**
 * Resolve the strategy for a provider.
 *
 * Precedence:
 *   1. Explicit `provider.contextStrategy` declaration (preferred).
 *   2. Fallback: `capabilities.has("history")` → `"history-aware"`,
 *      otherwise → `"inline-system"`.
 *
 * The fallback never returns `"gateway-stateful"`: gateway providers MUST
 * opt-in by declaring it explicitly, because the inspector messaging differs
 * meaningfully ("gateway may ignore this field") from a plain history-aware
 * provider.
 */
export function getProviderStrategy(provider: AIProvider): ProviderContextStrategy {
  if (provider.contextStrategy) return provider.contextStrategy;
  return provider.capabilities.has("history") ? "history-aware" : "inline-system";
}
