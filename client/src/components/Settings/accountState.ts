/**
 * Le decisioni della sezione Account, tenute fuori dal componente.
 *
 * Due sono le sole che possono sbagliare in modo interessante — SE mostrare la
 * sezione, e QUALE frase mettere su un rifiuto — e nessuna delle due ha bisogno
 * di un DOM per essere provata. Il componente resta il disegno; qui c'è ciò che
 * un test può interrogare.
 */

/**
 * La forma dello stato e l'elenco dei codici NON si ridichiarano qui: vivono in
 * `shared/account.ts`, che è lo stesso file da cui li prende il server. Una
 * seconda copia sul client compilerebbe benissimo anche il giorno in cui il
 * server aggiunge un motivo di rifiuto — e l'interfaccia direbbe «non è
 * riuscito» senza sapere perché. `tests/unit/no-type-mirrors.test.ts` fa
 * fallire chi ci riprova.
 */
export { CODICI_ACCOUNT } from '../../../../shared/account';
// Si ri-esporta `AccountState` e non `CodiceAccount`, che qui non ha lettori e
// non ne può avere: un codice che arriva dal filo NON è un `CodiceAccount`
// finché non lo si è guardato — è una stringa che un server più nuovo di questa
// interfaccia può aver inventato, ed è esattamente il caso che `chiaveErrore`
// esiste per non lasciare muto. Tiparlo all'ingresso sarebbe dichiarare
// impossibile la cosa da cui il modulo si difende. Chi domani volesse il tipo
// stretto DOPO il controllo lo prende da `shared/account`, dove vive.
export type { AccountState } from '../../../../shared/account';
import { CODICI_ACCOUNT } from '../../../../shared/account';
import type { AccountState } from '../../../../shared/account';

/**
 * Si mostra la sezione?
 *
 * NO quando questa installazione non ha un servizio degli account E nessuno è
 * collegato: sarebbe una scatola che spiega una cosa che qui non si può fare, e
 * il piano gratuito non è una versione mutilata di cui scusarsi — è il prodotto.
 *
 * SÌ appena c'è un collegamento, anche se il servizio nel frattempo è sparito:
 * un account collegato è un fatto che riguarda l'utente, e staccarlo è un gesto
 * locale che deve restare a portata di mano anche mentre la rete non c'è.
 *
 * `null` (non ancora caricato) è un NO: si disegna qualcosa quando si sa cosa.
 */
export function mostraSezione(s: AccountState | null): boolean {
  if (!s) return false;
  return s.configured || s.linked;
}

/**
 * Da un codice alla chiave della frase.
 *
 * Un codice sconosciuto — un server più nuovo dell'interfaccia — cade su una
 * frase generica invece che su un pannello vuoto: «non è andata» detto male è
 * comunque meglio di un rifiuto silenzioso, che chi guarda legge come un clic
 * che non ha fatto niente.
 */
export function chiaveErrore(codice: string | null | undefined): string {
  if (!codice) return 'account.err.generic';
  return (CODICI_ACCOUNT as readonly string[]).includes(codice)
    ? `account.err.${codice}`
    : 'account.err.generic';
}
