/**
 * «Questa chat si può buttare via?» — UNA definizione, per i due che se lo
 * chiedono.
 *
 * Quando l'utente ferma una risposta in volo, il client manda
 * `clearMessages: true` su `POST /api/chat/abort` se crede che la chat sia
 * appena nata (primo messaggio, annullato prima che il modello rispondesse).
 * Su quel «sì» succedono quattro cose distruttive:
 *
 *   - il server fa `saveLocalMessages(sessionKey, [])`, cioè
 *     `DELETE FROM messages WHERE session_key = ?`;
 *   - il client svuota la mappa in memoria e la cache locale;
 *   - il chiamante CHIUDE la pane (`usePaneLifecycle`, `useProjectLayout`);
 *   - dalla sidebar, ARCHIVIA il topic (`TopicTree`).
 *
 * ── Perché il predicato sta qui, in `shared/` ──────────────────────────────
 * Perché per un po' ce ne sono stati due, e sono divergiti. L'8 agosto 2026 il
 * server ha imparato a guardare se il turno aveva PRODOTTO qualcosa; il client
 * è rimasto a contare i messaggi utente (`userMessageCount <= 1`). Il 10 agosto
 * lo Stop sulla chat «Armonia — finance» ha mandato `clearMessages: true` su un
 * primo turno lungo otto minuti: il server ha rifiutato — a log,
 * `[Abort] Ignored clearMessages=true … e il turno aveva già prodotto lavoro` —
 * e il client ha eseguito lo stesso il suo ramo distruttivo. La chat è sparita
 * dalla pagina pur essendo intatta su disco. Due predicati sulla stessa riga
 * non si tengono allineati da soli: qui ce n'è uno.
 *
 * ── Perché il conteggio da solo non basta ──────────────────────────────────
 * Contare le righe sembra dire «l'assistente non ha ancora risposto». Non lo
 * dice: in questa app **tutto** il lavoro di un turno — testo, thinking, ogni
 * tool call — si accumula dentro l'UNICA riga assistente creata all'inizio
 * dello stream. Un primo turno di qualunque durata resta «1 utente + 1
 * assistente». Un turno che aveva già macinato diciassette tool contava 1+1
 * esattamente come un turno mai partito.
 *
 * Misurato sul DB di sviluppo al momento del fix server: **208 sessioni**
 * avevano quella forma, per **31,1 MB** di contenuto — tutte a un click di
 * distanza.
 *
 * Il predicato «ha prodotto qualcosa?» è quello di `shared/empty-turn.ts`, lo
 * stesso che usa lo scarto dei turni vuoti: guarda content, thinking, tool
 * call, blocchi e media.
 */

import { isEmptyAssistantTurn, type AssistantTurnShape } from "./empty-turn";

export interface ClearMessagesDecision {
  /** True iff the wipe is safe to perform. */
  shouldWipe: boolean;
  /** How many user-role messages the thread currently has. */
  userCount: number;
  /** How many assistant-role messages the thread currently has. */
  assistantCount: number;
  /** `true` se una riga assistente ha già prodotto qualcosa (testo, thinking,
   *  tool call, blocchi, media). È il motivo di rifiuto che il conteggio da
   *  solo non vedeva. */
  assistantDidWork: boolean;
  /** Righe della sessione che il ramo attivo NON contiene — e che una
   *  cancellazione butterebbe comunque. Diverso da zero ⇒ rifiuto. */
  hiddenRows: number;
}

/**
 * Decide se onorare un `clearMessages: true`, date le righe del thread.
 *
 * Si cancella solo quando il thread è ancora al primo turno E l'assistente non
 * ha prodotto niente: al più un messaggio utente, al più uno assistente, e
 * quella riga assistente VUOTA.
 *
 * @param threadMessages Il RAMO ATTIVO della sessione. Sul server è
 *        `loadActiveThread`, sul client la mappa in memoria già idratata.
 * @param sessionRowCount Righe della sessione INTERA, rami abbandonati
 *        compresi. Omesso = si assume che il ramo attivo sia tutto.
 *
 *        Perché serve: la cancellazione è `saveLocalMessages(sessionKey, [])`,
 *        cioè `DELETE FROM messages WHERE session_key = ?` — butta anche i rami
 *        che il predicato non ha mai guardato. Decidere sul sottoinsieme e
 *        distruggere l'insieme è come contare le stanze di un piano e demolire
 *        il palazzo. Misurato al momento del fix: 9 sessioni avevano righe
 *        fuori dal ramo attivo. Il client questo numero NON ce l'ha: per questo
 *        la parola definitiva sul wipe resta quella del server (il campo
 *        `cleared` nella risposta di `/api/chat/abort`).
 */
export function shouldHonorClearMessages(
  threadMessages: readonly AssistantTurnShape[],
  sessionRowCount?: number,
): ClearMessagesDecision {
  let userCount = 0;
  let assistantCount = 0;
  let assistantDidWork = false;
  for (const msg of threadMessages) {
    if (msg.role === "user") userCount++;
    else if (msg.role === "assistant") {
      assistantCount++;
      if (!isEmptyAssistantTurn(msg)) assistantDidWork = true;
    }
  }
  const hiddenRows =
    sessionRowCount === undefined ? 0 : Math.max(0, sessionRowCount - threadMessages.length);
  return {
    shouldWipe: userCount <= 1 && assistantCount <= 1 && !assistantDidWork && hiddenRows === 0,
    userCount,
    assistantCount,
    assistantDidWork,
    hiddenRows,
  };
}
