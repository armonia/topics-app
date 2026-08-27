import type { ContentBlock } from '../../types';

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
}): boolean {
  if (!input.lastMessageIsUser) return false;
  return !input.locallyStreaming && !input.serverSaysOpen;
}
