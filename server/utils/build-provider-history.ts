/**
 * buildProviderHistory — builds a stateless `ChatMessage[]` transcript for
 * provider consumption from the SQLite-persisted active thread.
 *
 * Why this exists: previously the conversation history sent to providers like
 * `claude` (Anthropic SDK), `openai`, and `codex` was reconstructed from the
 * client POST body (`body.messages`). That made the *client* the source of
 * truth for AI memory — anything that wiped client RAM (refresh, mid-stream
 * disconnect, freshly opened topic, race with the WS reconnect on a server
 * `bun --watch` reload) would silently strip context and the model would
 * "forget" prior turns.
 *
 * Topics-app already persists every turn in the `messages` table via
 * `appendLocalMessage`. This helper turns that persisted active thread into
 * the shape providers expect, applying the same filters the client uses
 * (`isContextMessage`, marker stripping) so internal scaffolding never leaks
 * back to the model.
 *
 * Note: `StoredMessage.role` is only `"user" | "assistant"` — system
 * scaffolding (SOUL.md, plan mode, context files) is injected at request time
 * by the route handler and is *not* part of the persisted thread. The caller
 * is responsible for prepending those system messages before forwarding to
 * the provider.
 */

import type { ChatMessage } from "../providers/types";
import type { StoredMessage } from "../types";

export interface BuildProviderHistoryOptions {
  /**
   * Maximum number of non-system turns to keep, counted from the most recent.
   * Defaults to 100 — generous for token budgets but bounded enough to avoid
   * runaway prompts on very long topics.
   */
  limit?: number;
  /**
   * When true, drop the very last entry. Used when the caller has just
   * persisted the user's new turn and will pass it to the provider as the
   * fresh prompt, so we don't want to duplicate it inside `options.history`.
   */
  excludeLast?: boolean;
}

const CONTEXT_PREFIX = "[Chat messages since your last reply";

/**
 * Mirror of the client-side filter in `client/src/hooks/useChat.ts:172-174`.
 * The OpenClaw gateway used to inline a synthetic system-style assistant turn
 * starting with this prefix; replaying it would confuse downstream models.
 */
function isContextMessage(content: string): boolean {
  return content.startsWith(CONTEXT_PREFIX);
}

// Marker stripping (`{{BROWSER:…}}`, `{{TOPIC_*:…}}`, `{{PROJECT_*:…}}`) uses
// the canonical grammar in `../lib/markers` — the single source of truth shared
// with the streaming path (routes/topics.ts) and the context assembler. This
// previously reimplemented only 3 of the 5 marker families, leaking
// `{{PROJECT_OPEN/CREATE:…}}` back into provider history (audit #4).

export function buildProviderHistory(
  storedMessages: StoredMessage[],
  options: BuildProviderHistoryOptions = {},
): ChatMessage[] {
  const { limit = 100, excludeLast = false } = options;

  let normalized: ChatMessage[] = storedMessages
    // Skip in-flight assistant turns — their content is empty or partial and
    // would teach the model that it's allowed to truncate itself.
    .filter((m) => !m.partial)
    // Skip OpenClaw-injected context envelopes (cosmetic chunk markers).
    .filter((m) => !isContextMessage(m.content || ""))
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as ChatMessage["role"],
      content: (m.content || "").trim(),
    }))
    // Drop turns that are empty after trimming.
    .filter((m) => m.content.length > 0);

  if (excludeLast && normalized.length > 0) {
    normalized = normalized.slice(0, -1);
  }

  if (normalized.length > limit) {
    normalized = normalized.slice(-limit);
  }

  return normalized;
}
