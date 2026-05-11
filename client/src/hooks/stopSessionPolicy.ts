/**
 * Policy for the "first-message wipe" branch of `stopSession` in `useChat`.
 *
 * Background — why this exists as its own module:
 *
 * When the user clicks Stop on an in-flight assistant reply, the client used
 * to compute `isFirstMessage` directly from `messagesRef.current` and pass
 * `clearMessages: true` to `POST /api/chat/abort`, which made the server call
 * `saveLocalMessages(sessionKey, [])` and **wipe the entire conversation
 * history from SQLite**.
 *
 * That worked while the tab was the source of truth, but it gives wrong
 * answers when the local in-memory map is empty for non-content reasons:
 *
 *  - The user just switched into a tab that hasn't finished `loadHistory()`
 *    yet (race: stop click before the GET /history response lands).
 *  - The page was hot-reloaded mid-stream and the React state is fresh.
 *  - A WebSocket reconnect dropped the local cache but the server still has
 *    a full thread on disk.
 *
 * In all three cases the local `userMessageCount` reads as 0 even though the
 * conversation has 50+ persisted turns. The client would then ask the server
 * to wipe and the server (until the regression guard landed) would oblige.
 *
 * The fix is two-sided (defense in depth):
 *
 *  1. **Client** (here): never claim "this is the first message" until we've
 *     actually hydrated the local state from the server's history endpoint.
 *  2. **Server** (`abortClearPolicy.ts`): re-derive the count from the DB and
 *     refuse to wipe a thread that already has multiple stored turns,
 *     regardless of what the client said.
 *
 * Either layer alone would catch the bug; both together close every race we
 * can think of and the next one we can't.
 */

/**
 * Decide whether the client may wipe its own session state (and ask the
 * server to do the same) when the user stops an in-flight stream.
 *
 * The wipe is intended for "I started typing, immediately changed my mind,
 * cancel before anything is saved". It must NOT fire for any longer thread.
 *
 * @param hydrated         True iff `loadHistory()` (or another server-truth
 *                         path) has populated this session's messages map at
 *                         least once. While false the local count is not
 *                         authoritative and we MUST NOT wipe.
 * @param userMessageCount Number of user-role messages currently in the
 *                         local map for this session. Only consulted when
 *                         `hydrated` is true.
 */
export function decideClientWipeOnStop(
  hydrated: boolean,
  userMessageCount: number,
): boolean {
  if (!hydrated) return false;
  return userMessageCount <= 1;
}
