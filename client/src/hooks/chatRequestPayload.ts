/**
 * QUANTO PESA UN INVIO — e quanto ne legge davvero il server.
 *
 * `POST /api/chat` riceveva l'INTERO trascritto a ogni turno, più una copia in
 * fondo dell'ultimo messaggio dell'utente. Sul lato server quel corpo ha due
 * lettori soli, e nessuno dei due vuole tutto:
 *
 *  • il ramo legato a una topic — cioè ogni chat vera — legge
 *    `messages[messages.length - 1]` e basta (`server/routes/chat.ts`: da lì
 *    esce la riga utente da scrivere in DB). La storia se la ricostruisce da
 *    solo con `assembleTopicContext`, che legge il DB: l'array caricato dal
 *    client non lo guarda nessuno e finisce nel cestino;
 *  • il ramo SENZA topic (l'inviluppo degenere del fallback HTTP) è l'unico che
 *    usa l'array: `history = messages.filter(user|assistant).slice(0, -1)`.
 *
 * Da qui le due regole di questo modulo. L'ULTIMO elemento è il messaggio che si
 * sta inviando, e uno solo: la copia in coda faceva scrivere due volte lo stesso
 * turno nella storia del ramo senza topic. E ciò che sta prima è una CODA
 * limitata, perché è tutto ciò che quel ramo può usare — su una conversazione
 * lunga il resto erano megabyte spediti a ogni tasto premuto per essere buttati.
 *
 * Puro: si prova sotto `bun:test`, vedi `chatRequestPayload.test.ts`.
 */

import type { ChatMessage, Message } from '../types';

/**
 * Il tetto della coda, in caratteri di contenuto.
 *
 * Caratteri e non byte: `TextEncoder` su ogni messaggio costerebbe una passata
 * su tutta la conversazione proprio nel momento in cui si vuole essere leggeri,
 * e qui serve un ORDINE DI GRANDEZZA, non una misura al byte. Il valore copre
 * comodamente una decina di turni di prosa, che è quanto il ramo di fallback
 * può usare prima che il modello tagli comunque.
 */
export const REQUEST_TAIL_BUDGET_CHARS = 64 * 1024;

/**
 * Il corpo di `POST /api/chat`: una coda limitata della conversazione, e in
 * fondo — una volta sola — il messaggio che si sta inviando.
 *
 * `sessionMessages` è lo stato locale DOPO che la bolla utente è stata aggiunta,
 * quindi normalmente finisce già con questo stesso messaggio: quella copia si
 * riconosce e non si duplica.
 */
export function buildRequestMessages(
  sessionMessages: ChatMessage[],
  content: string,
  budgetChars: number = REQUEST_TAIL_BUDGET_CHARS,
): Message[] {
  let end = sessionMessages.length;
  const last = sessionMessages[end - 1];
  if (last?.role === 'user' && last.content === content) end -= 1;

  const tail: Message[] = [];
  let speso = 0;
  for (let i = end - 1; i >= 0; i--) {
    const m = sessionMessages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const testo = m.content ?? '';
    // Una bolla senza testo non dice niente al ramo che legge questa lista (una
    // corsa di soli tool, il segnaposto di un turno in volo): occupa una riga e
    // non porta contesto.
    if (testo.trim().length === 0) continue;
    if (speso + testo.length > budgetChars && tail.length > 0) break;
    speso += testo.length;
    tail.push({ role: m.role, content: testo });
  }
  tail.reverse();

  tail.push({ role: 'user', content });
  return tail;
}
