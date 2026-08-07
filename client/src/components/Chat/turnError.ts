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

/** Il prefisso con cui il server marcava i cartelli prima che esistesse il
 *  blocco `error`. Le righe già in DB si leggono ancora così. */
export const LEGACY_ERROR_PREFIX = '⚠️';

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
  const dalBlocco = msg.blocks?.find((b) => b.kind === 'error');
  if (dalBlocco) return dalBlocco.text;
  const c = msg.content ?? '';
  return c.startsWith(LEGACY_ERROR_PREFIX) ? c.slice(LEGACY_ERROR_PREFIX.length).trim() : null;
}
