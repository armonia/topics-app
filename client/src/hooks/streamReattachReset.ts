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

/**
 * THE BUBBLE THAT WAS ALREADY CLOSED AND IS ALIVE AGAIN.
 *
 * The server can hand a NEW turn the id of a row that already exists and is
 * finished: it happens when a spontaneous turn picks up the «no answer»
 * headstone the CLI's own task-notification turn left behind (see
 * `server/lib/empty-turn-headstone.ts`). On the wire that is a `stream:start`
 * whose `messageId` names a bubble this window already has, and finished.
 *
 * Without this the fallback below would append a SECOND bubble with the very
 * same id: two React children on one key, the false notice still on screen,
 * and the answer written underneath it — that is, the bug the reuse existed to
 * remove, moved one floor up.
 *
 * The bubble is emptied and reopened WHERE IT IS, keeping its position in the
 * thread: it is the same turn answering the same message.
 *
 * Returns the IDENTICAL array when there is nothing to revive, so a caller
 * passing it to `setState` does not repaint half a chat for nothing.
 */
export function reviveClosedBubble(messages: ChatMessage[], id: string): ChatMessage[] {
  if (!id) return messages;
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return messages;
  const found = messages[i];
  if (found.role !== 'assistant' || found.partial) return messages;
  const revived: ChatMessage = { ...found, content: '', partial: true };
  delete revived.thinking;
  delete revived.toolCalls;
  delete revived.blocks;
  return [...messages.slice(0, i), revived, ...messages.slice(i + 1)];
}
