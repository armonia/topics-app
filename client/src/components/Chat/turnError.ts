import type { ContentBlock, TurnEndCause } from '../../types';

/**
 * Perché un turno è finito male — la domanda posta UNA volta.
 *
 * Vive in un modulo suo, non dentro `MessageContent`: la risposta serve a due
 * componenti (il banner qui, il bottone «Riprova» in `MessageBubble`) e un file
 * che esporta componenti E funzioni spegne il fast refresh di Vite. Ma la
 * ragione vera è un'altra: finché la regola stava scritta due volte, poteva
 * divergere — ed era già successo, con la scatola ambra accesa da un cancello e
 * il bottone per rimediarci da un altro.
 */

/** Il prefisso con cui il server marca i cartelli anche in `content`.
 *  Ri-esportato: la costante vive in `shared/board.ts` perché la legge anche il
 *  server (`getLastAgentText`), e due copie divergono al primo cambio. */
export { TURN_ERROR_PREFIX as LEGACY_ERROR_PREFIX } from '../../../../shared/board';
import { TURN_ERROR_PREFIX as LEGACY_ERROR_PREFIX } from '../../../../shared/board';

/**
 * Il verdetto sul turno, o `null` se il turno è andato bene.
 *
 * Due sorgenti, nell'ordine: il blocco `error` (la forma nuova) e — per le
 * righe già scritte — il testo di `content` che comincia con ⚠️. La seconda
 * serve perché sono 214 righe in produzione, e 45 di quelle hanno anche i
 * `blocks`: lì `content` non viene stampato affatto, quindi finché il cartello
 * vive solo nel testo quelle righe restano senza spiegazione.
 */
export function turnErrorOf(msg: { content?: string; blocks?: ContentBlock[] | null }): string | null {
  const fromBlock = msg.blocks?.find((b) => b.kind === 'error');
  if (fromBlock) return fromBlock.text;
  const c = (msg.content ?? '').trim();
  if (!c.startsWith(LEGACY_ERROR_PREFIX)) return null;
  // Solo il PRIMO capoverso. Un cartello vecchio è sempre una frase sola, ma la
  // riga su cui sta può portare altro: una riadozione ci appende il contenuto
  // rifuso, e prendere tutto significherebbe stampare nel banner la stessa prosa
  // che i blocchi renderizzano già sotto — lo stesso testo, due volte.
  const primoCapoverso = c.slice(LEGACY_ERROR_PREFIX.length).split(/\n\s*\n/)[0];
  return primoCapoverso.trim() || null;
}

/**
 * La riga porta LAVORO oltre al verdetto?
 *
 * Il gemello client di `rowCarriesWork`. Serve al bottone «Riprova»: rimandare
 * il messaggio di un turno che ha già risposto non ripara niente — ne fa un
 * secondo, a pagamento. Il cartello dice che qualcosa è andato storto; solo
 * l'assenza di lavoro dice che c'è da rifarlo.
 */
export function turnIsOnlyError(msg: {
  content?: string;
  blocks?: ContentBlock[] | null;
  toolCalls?: unknown[] | null;
}): boolean {
  if (turnErrorOf(msg) === null) return false;
  if (msg.toolCalls?.length) return false;
  if (msg.blocks?.some((b) => b.kind !== 'error')) return false;
  // Nel formato vecchio il verdetto È il contenuto: tutto ciò che resta oltre al
  // primo capoverso è lavoro vero.
  const c = (msg.content ?? '').trim();
  if (!c.startsWith(LEGACY_ERROR_PREFIX)) return true; // il verdetto sta nei blocchi, e content è vuoto
  return c.slice(LEGACY_ERROR_PREFIX.length).split(/\n\s*\n/).length === 1;
}

/**
 * WAS THE TURN INTERRUPTED, AND BY WHOM - the banner's question.
 *
 * THE REPORT, 2026-09-03: a turn closed by the watchdog at 22:25, and the chat
 * "stuck with no feedback at all". The only sign was a line appended at the
 * bottom of a long message, "[Response timed out]", which nobody reads: getting
 * to the bottom of a wall of text takes scrolling on purpose. The real cause
 * (the reaper had killed the child process) was in the server log, and there
 * was no way out: resend the message, or keep waiting, was left to guessing.
 *
 * WHY THE CAUSE IS ASKED, NOT THE TEXT. The verdict's text is English prose
 * written by the server: it prints, nothing gets decided on it. The code
 * (`STOP_CAUSES`, the same one `stream:end` speaks) answers the two questions
 * that matter - which sentence, in which language - and a third one, which is
 * why the banner does not shout out of turn: `user` is NOT an interruption to
 * explain. Whoever pressed stop already knows why the turn ended, and has their
 * own banner for it.
 *
 * OLD ROWS HAVE NO CAUSE, and stay without a banner: a missing `cause` means
 * "not attributed", not "watchdog". Reopening a three-week-old chat must not
 * light an amber box over a turn nobody will resend; the verdict inside the
 * bubble is there as before.
 */
export function interruptedTurnOf(msg: {
  blocks?: ContentBlock[] | null;
}): { cause: TurnEndCause; text: string; at?: string } | null {
  const block = msg.blocks?.find((b) => b.kind === 'error');
  if (!block || block.kind !== 'error') return null;
  if (!block.cause || block.cause === 'user') return null;
  return { cause: block.cause, text: block.text, at: block.at };
}

/**
 * The sentence explaining the cause, by translation key.
 *
 * An EXPLICIT map and not a key built at runtime from the cause: a computed key
 * is one nobody can search for in the catalogues, and the first cause added to
 * `STOP_CAUSES` without its sentence would come out as the code name printed in
 * the reader's face. This way it does not compile instead.
 */
export const TURN_CAUSE_KEY: Record<TurnEndCause, string> = {
  'user': 'chat.turnStopped',
  'watchdog': 'chat.turnInterrupted.watchdog',
  'wall-clock': 'chat.turnInterrupted.wallClock',
  'server-shutdown': 'chat.turnInterrupted.serverShutdown',
  'stall': 'chat.turnInterrupted.stall',
  'session-reset': 'chat.turnInterrupted.sessionReset',
  'process-died': 'chat.turnInterrupted.processDied',
  'turn-in-flight': 'chat.turnInterrupted.turnInFlight',
  'superseded': 'chat.turnInterrupted.superseded',
  'provider-error': 'chat.turnInterrupted.providerError',
  'rate-limit': 'chat.turnInterrupted.rateLimit',
};

/**
 * THE SAME VERDICT, BUILT FROM THE EVENT INSTEAD OF THE ROW.
 *
 * The gap this closes is the one the report is actually about: the watchdog
 * fires WHILE somebody is watching the chat. The server writes the cause on the
 * row, but this page already holds that message in memory and nothing puts it
 * there: `stream:end` flipped the spinner off and left the bubble as it was, so
 * the banner appeared only after a reload. Which is to say: it did not appear
 * to the one person who was there to see it.
 *
 * The data was already on the wire - `stopCause` has been on `stream:end` since
 * long before this banner - it was simply never applied. So no new field: the
 * event is read, and the row in memory gets the same block the server just
 * persisted. A reload afterwards shows the identical thing.
 *
 * MEMBERSHIP IS TESTED AGAINST `TURN_CAUSE_KEY`, not against `STOP_CAUSES`.
 * Two reasons, and the second is the one that matters. `STOP_CAUSES` lives in
 * `shared/ws-outbound.ts`, which imports zod: importing the VALUE here would
 * drag a schema library into the chat bundle to check ten strings. And the map
 * is the more honest test anyway - it answers "can I render this cause?", which
 * is the actual question, so a cause we have no sentence for cannot reach the
 * banner as a code name.
 */
export function liveInterruptionBlock(input: {
  /** `stopCause` from the `stream:end` event, if it carried one. */
  stopCause?: string;
  /** The server's own sentence, when the event carried one. */
  error?: string;
  /** The blocks already on the row: a verdict there wins over ours. */
  blocks?: ContentBlock[] | null;
}): ContentBlock | null {
  const cause = input.stopCause;
  if (!cause || cause === 'user') return null;
  if (!(cause in TURN_CAUSE_KEY)) return null;
  // Somebody already explained, and their version is on the row: adding ours
  // would show two verdicts for one turn.
  if (input.blocks?.some((b) => b.kind === 'error')) return null;
  return {
    kind: 'error',
    // The text is the FALLBACK: the banner renders the translated cause. When
    // the event carried no sentence (the reaper's `stream:end` does not), the
    // cause alone is what we have, and it is enough to render.
    text: (input.error ?? '').replace(/^\u26a0\ufe0f\s*/, '').trim(),
    cause: cause as TurnEndCause,
    at: new Date().toISOString(),
  };
}

/**
 * IL TURNO È ANCORA VIVO? La domanda che decide se mostrare «Nessuna risposta».
 *
 * IL DIFETTO CHE ESISTE PER CHIUDERE, riportato il 2026-08-19: mando un
 * messaggio, ricarico la finestra, e il messaggio **sparisce**; poi ricompare
 * con la scatola ambra «Nessuna risposta — la connessione può essersi
 * interrotta», mentre l'agente sta lavorando eccome. Due bugie in fila su un
 * turno sano: la prima fa temere di aver perso ciò che si è scritto, la seconda
 * invita a rimandarlo — e rimandarlo significa un SECONDO turno, a pagamento,
 * mentre il primo è ancora in corso.
 *
 * PERCHÉ SUCCEDEVA. Il banner guardava `currentStreaming`, cioè
 * `isSessionStreaming` → la mappa `streaming` locale di `useChat`. Quella mappa
 * è memoria di PROCESSO: un reload la azzera, e nessuno la ripopola. Il fatto
 * che il server stia ancora servendo quel turno c'è ed è autorevole — la rotta
 * `GET /api/topics/streaming`, che `useSignalsSync` interroga ogni 15 s
 * versando gli id in `hydratedStreamTopics` — ma il banner non lo consultava.
 * Il commento accanto al banner affermava il contrario («il caso "il turno è
 * ancora vivo" non passa di qui»), e affermarlo non lo rendeva vero:
 * `reconcileServerStreams` SPEGNE gli spinner rimasti accesi per una fine
 * persa, non li riaccende dopo un reload. Fa il verso opposto a quello che
 * serviva qui.
 *
 * LA REGOLA, in una riga: il banner è per un turno che NON risponde, e «non
 * risponde» richiede che nessuno dei due testimoni lo dica vivo — né la sessione
 * locale, né il registro del server. Basta uno dei due.
 *
 * PERCHÉ SBAGLIARE DA UN LATO È PEGGIO. Un banner mancante su un turno davvero
 * morto costa un'attesa e un gesto in più (il messaggio resta lì, si rimanda).
 * Un banner di troppo su un turno VIVO invita a duplicarlo: due agenti sulla
 * stessa richiesta, due conti da pagare, e un thread che nessuno dei due
 * riconosce più come suo. Nel dubbio si tace.
 */
export function turnLooksUnanswered(input: {
  /** L'ultimo messaggio della chat è dell'utente? Senza questo non c'è attesa. */
  lastMessageIsUser: boolean;
  /** La sessione LOCALE sta streammando (memoria di processo, muore al reload). */
  locallyStreaming: boolean;
  /**
   * Il SERVER dice che questo topic ha un turno aperto — streaming o fermo su
   * una domanda. Sopravvive al reload, ed è la testimonianza che mancava.
   */
  serverSaysOpen: boolean;
  /**
   * Has the server's registry been read at least once since this page loaded?
   * Until then `serverSaysOpen` is not «no», it is «nobody asked yet»: on a
   * reload the local map is empty and the GET is still in flight, and the
   * banner drawn in that window was a 51 px composer that shrank under the
   * conversation the moment the answer came (measured 2026-09-03).
   */
  serverAsked: boolean;
}): boolean {
  if (!input.lastMessageIsUser) return false;
  if (!input.serverAsked) return false;
  return !input.locallyStreaming && !input.serverSaysOpen;
}
