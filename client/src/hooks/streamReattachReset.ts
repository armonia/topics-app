// Cosa fare con la bolla quando il turno che la stava scrivendo viene
// RIADOTTATO dopo un riavvio del server (`stream:start` con `reattached`).
//
// Il turno non comincia: riprende. Il provider ri-detta il turno da capo dal
// suo JSONL, e quelle arrivano come `stream:content_chunk`, che il client
// APPENDE. Se la bolla porta ancora il testo di prima del riavvio — e lo porta,
// perché è quello che `/api/history` ha appena servito — il replay si somma a
// sé stesso e il turno esce doppio.
//
// Prima l'azzeramento lo faceva il server, cancellando il corpo della riga in
// DB al momento dell'adozione. Ma la copia di quel che cancellava viveva solo
// in RAM, dentro la richiesta di riadozione: se quella moriva prima di
// rimetterla a posto (un secondo riavvio del watcher, il provider giù, un
// timeout) la cancellazione era definitiva e restava una bolla vuota per
// sempre. Misurato su topic:dc2b90d0 il 10 agosto.
//
// Quindi ad azzerarsi è la VISTA, non il record: questa funzione. La vista si
// rifà da sola al prossimo `/api/history`; il record no.

import type { ChatMessage } from '../types';

/**
 * Svuota la bolla che il replay sta per ridettare, lasciandola al suo posto e
 * col suo id — è la stessa bolla, non una nuova, o comparirebbe un doppione.
 *
 * Ritorna l'array IDENTICO (stesso riferimento) quando non c'è niente da
 * svuotare, così chi lo passa a `setState` non fa ridisegnare mezza chat per
 * un evento che non cambia niente.
 */
export function clearPartialForReattach(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.partial) return messages;
  // Già vuota: nessun motivo di toccare lo stato. Succede quando il riattacco
  // arriva su una finestra aperta DOPO il riavvio, che la bolla ce l'ha già
  // pulita.
  if (!last.content && !last.thinking && !last.toolCalls?.length && !last.blocks?.length) return messages;
  const cleared: ChatMessage = { ...last, content: '', partial: true };
  delete cleared.thinking;
  delete cleared.toolCalls;
  delete cleared.blocks;
  return [...messages.slice(0, -1), cleared];
}
