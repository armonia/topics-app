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
 * La difesa è su tre strati, e nessuno da solo basta:
 *
 *  1. **Idratazione** (qui): finché il server non ci ha detto cosa c'è davvero
 *     nel thread, il conteggio locale non è autorevole e non si cancella.
 *  2. **Il predicato condiviso** (`shared/clear-messages-policy.ts`): la stessa
 *     funzione che usa il server. Prima ce n'erano due — il server guardava se
 *     il turno aveva prodotto lavoro, qui si contavano solo i messaggi utente —
 *     e il 10 agosto 2026 lo Stop su un primo turno lungo otto minuti ha
 *     svuotato la pagina mentre il server rifiutava di svuotare il disco.
 *  3. **L'esito del server** (`useChat.stopSession`): il ramo distruttivo —
 *     svuota la chat, chiude la pane, archivia il topic — parte solo se
 *     `/api/chat/abort` risponde `cleared: true`. Il server vede cose che qui
 *     non si vedono: le righe fuori dal ramo attivo, che la cancellazione
 *     butterebbe comunque.
 */

import { shouldHonorClearMessages } from "../../../shared/clear-messages-policy";
import type { AssistantTurnShape } from "../../../shared/empty-turn";

/**
 * Decide whether the client may propose the wipe (and act on it once the
 * server agrees) when the user stops an in-flight stream.
 *
 * The wipe is intended for "I started typing, immediately changed my mind,
 * cancel before anything is saved". It must NOT fire for any longer thread,
 * nor for a first turn that has already produced work.
 *
 * @param hydrated True iff `loadHistory()` (or another server-truth path) has
 *                 populated this session's messages map at least once. While
 *                 false the local list is not authoritative and we MUST NOT
 *                 wipe.
 * @param messages The session's messages as the client currently has them.
 *                 Only consulted when `hydrated` is true.
 */
export function decideClientWipeOnStop(
  hydrated: boolean,
  messages: readonly AssistantTurnShape[],
): boolean {
  if (!hydrated) return false;
  return shouldHonorClearMessages(messages).shouldWipe;
}
