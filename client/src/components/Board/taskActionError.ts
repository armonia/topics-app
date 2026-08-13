/**
 * Il messaggio di un'azione FALLITA su una card, detto in italiano.
 *
 * Il server risponde 409 con una frase inglese pensata per un agente («task has
 * open subtasks…»): sulla board la legge una persona, e la legge nel momento in
 * cui il suo click non ha fatto niente. Qui si traduce nella frase che dice
 * anche COSA fare, una volta sola per tutte le superfici (card e drawer usano
 * questa, non ognuna la sua).
 *
 * Modulo PURO: nessuna chiamata, nessun React. Dove si DISEGNA l'errore lo
 * decide il chiamante, ed è la parte che questo task ha cambiato: accanto al
 * bottone premuto, non nella barra in cima al board.
 */

/**
 * @param raw messaggio grezzo dell'errore (di solito `Error.message` dell'API).
 * @param fallback cosa dire quando `raw` è vuoto (es. «Approva non è riuscito»).
 */
export function taskActionErrorMessage(raw: unknown, fallback = 'azione non riuscita'): string {
  const text = (raw instanceof Error ? raw.message : String(raw ?? '')).trim();
  if (!text) return fallback;
  // Il gate che sorprende chi approva: il padre non si chiude finché un figlio
  // è aperto, e il figlio si vede sulla card (la checklist si espande in review).
  if (/open subtasks/i.test(text)) {
    return 'Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.';
  }
  return text;
}
