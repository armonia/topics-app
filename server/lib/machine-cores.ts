/**
 * Quanti core ha questa macchina. Una domanda sola, una risposta sola.
 *
 * Sembra una riga di niente, ed è invece il punto in cui il freno del dispatch
 * si è rotto in silenzio. `os.cpus()` NON è affidabile: enumera le CPU via
 * sysctl a ogni chiamata, e su macOS sotto carico pesante quella lettura può
 * tornare VUOTA. Chi scrive `Math.max(1, os.cpus().length)` non vede un errore:
 * vede una macchina a un core.
 *
 * Misurato il 13/08/2026, e non per ragionamento: la suite unitaria è caduta su
 * un solo caso, e la riga di spiegazione del tetto diceva «1 core → base 2» su
 * un host da 12. Due letture indipendenti nello stesso processo, entrambe a
 * uno, senza nessun mock nel repo. Succedeva sotto la suite intera e mai sul
 * file da solo, cioè esattamente quando la macchina era occupata.
 *
 * È il difetto peggiore che potesse capitare a questo modulo: il conto della
 * capacità crolla proprio quando la macchina è carica, cioè quando quel conto
 * è l'unica cosa che tiene in piedi la flotta. Un tetto che si dimensiona su
 * una macchina immaginaria da un core è lo stesso guasto che si sta riparando,
 * entrato da un'altra porta.
 *
 * Due difese, e servono tutte e due:
 *  · si preferisce `availableParallelism()`, che risponde con un intero e non
 *    costruisce un elenco;
 *  · il valore NON SCENDE MAI. Una macchina non perde core: se una lettura ne
 *    dice meno della migliore vista finora, la lettura è sbagliata, non la
 *    macchina. E finché nessuna lettura riesce si riprova al giro dopo, invece
 *    di congelare per sempre uno zero preso male al primo import.
 */
import os from "node:os";

let migliore = 0;

export function machineCores(): number {
  let letto = 0;
  try { letto = os.availableParallelism?.() ?? 0; } catch { /* non c'è ovunque */ }
  if (!letto) { try { letto = os.cpus().length; } catch { /* può esplodere */ } }
  if (letto > migliore) migliore = letto;
  return Math.max(1, migliore);
}
