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
