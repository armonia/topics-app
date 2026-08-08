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
import { isEmptyAssistantTurn, type AssistantTurnShape } from "../../shared/empty-turn";

export interface ClearMessagesDecision {
  /** True iff the wipe is safe to perform — both counts ≤ 1. */
  shouldWipe: boolean;
  /** How many user-role messages the DB currently has. */
  userCount: number;
  /** How many assistant-role messages the DB currently has. */
  assistantCount: number;
  /** `true` se una riga assistente ha già prodotto qualcosa (testo, thinking,
   *  tool call, blocchi, media). È il motivo di rifiuto che il conteggio da
   *  solo non vedeva. */
  assistantDidWork: boolean;
}

/**
 * Decide whether to honor a `clearMessages: true` hint, given the
 * authoritative messages currently persisted for the session.
 *
 * Allow the wipe only when the stored thread is still at "first turn" AND the
 * assistant has produced nothing: at most one user message, at most one
 * assistant message, e quella riga assistente VUOTA.
 *
 * ── Perché il conteggio da solo non basta (incidente 8 agosto 2026) ─────────
 * Contare le righe sembrava dire «l'assistente non ha ancora risposto», che è
 * l'intento scritto qui sopra. Non lo dice: in questa app **tutto** il lavoro di
 * un turno — testo, thinking, ogni tool call — si accumula dentro l'UNICA riga
 * assistente creata all'inizio dello stream. Un primo turno di qualunque durata
 * resta «1 utente + 1 assistente». Quindi un turno che aveva già macinato
 * diciassette tool contava 1+1 esattamente come un turno mai partito, e lo Stop
 * lo cancellava: `saveLocalMessages(sessionKey, [])`, DELETE in transazione,
 * nessun backup. È così che è sparita una chat vera.
 *
 * Misurato sul DB di sviluppo nel momento del fix: **208 sessioni** avevano
 * quella forma, per **31,1 MB** di contenuto — tutte a un click di distanza. E
 * il ramo di rifiuto non era mai scattato in 91 MB di log.
 *
 * Il predicato «ha prodotto qualcosa?» esisteva già ed è quello che usa lo
 * scarto dei turni vuoti (`shared/empty-turn.ts`): guarda content, thinking,
 * tool call, blocchi e media. Riusarlo tiene UNA definizione di «vuoto» invece
 * di due libere di divergere.
 */
export function shouldHonorClearMessages(
  storedMessages: readonly StoredMessage[],
): ClearMessagesDecision {
  let userCount = 0;
  let assistantCount = 0;
  let assistantDidWork = false;
  for (const msg of storedMessages) {
    if (msg.role === "user") userCount++;
    else if (msg.role === "assistant") {
      assistantCount++;
      if (!isEmptyAssistantTurn(msg as AssistantTurnShape)) assistantDidWork = true;
    }
  }
  return {
    shouldWipe: userCount <= 1 && assistantCount <= 1 && !assistantDidWork,
    userCount,
    assistantCount,
    assistantDidWork,
  };
}
