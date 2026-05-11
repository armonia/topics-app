/**
 * Server-side guard for the `clearMessages: true` hint on `/api/chat/abort`.
 *
 * The client sends `clearMessages: true` when it believes the conversation
 * being aborted is brand-new (only the first user message exists, the
 * assistant never got to reply). The intent is to discard the throwaway
 * chat entirely. But the client computes that hint from its own in-memory
 * state, which is empty during the initial mount, after a hot-reload, and
 * after a WebSocket reconnect — so trusting it would let an innocuous Stop
 * click wipe a 50-turn conversation from disk.
 *
 * This module gives us a single function that re-derives the same decision
 * from the authoritative DB copy. The route handler in `topics.ts` calls
 * `shouldHonorClearMessages()` and refuses the wipe whenever the stored
 * thread doesn't match the "brand-new" shape, no matter what the client
 * claimed.
 *
 * The companion client guard lives in
 * `client/src/hooks/stopSessionPolicy.ts` — see the docstring there for the
 * full defense-in-depth rationale.
 */

import type { StoredMessage } from "../types";

export interface ClearMessagesDecision {
  /** True iff the wipe is safe to perform — both counts ≤ 1. */
  shouldWipe: boolean;
  /** How many user-role messages the DB currently has. */
  userCount: number;
  /** How many assistant-role messages the DB currently has. */
  assistantCount: number;
}

/**
 * Decide whether to honor a `clearMessages: true` hint, given the
 * authoritative messages currently persisted for the session.
 *
 * Allow the wipe only when the stored thread is still at "first turn":
 * at most one user message AND at most one assistant message. Any larger
 * thread is treated as a real conversation and the wipe is denied so the
 * regular partial-finalize path can run instead.
 */
export function shouldHonorClearMessages(
  storedMessages: readonly StoredMessage[],
): ClearMessagesDecision {
  let userCount = 0;
  let assistantCount = 0;
  for (const msg of storedMessages) {
    if (msg.role === "user") userCount++;
    else if (msg.role === "assistant") assistantCount++;
  }
  return {
    shouldWipe: userCount <= 1 && assistantCount <= 1,
    userCount,
    assistantCount,
  };
}
