/**
 * PERCHÉ si è sul piano che si è: i sette motivi, in un posto solo.
 *
 * Sta in `shared/` e non da un lato solo perché lo leggono in due, e per cose
 * diverse: il server li PRODUCE (`verificaGettone` esce da uno di questi sette
 * rami) e il client ci appende una frase per ciascuno. Erano due dichiarazioni
 * gemelle, una per lato, finché il cricchetto anti-specchio non l'ha detto —
 * ed è esattamente il caso che quel cricchetto esiste per prendere: il giorno
 * in cui il server distingue un ottavo motivo, una copia nel client resta a
 * sette e non se ne accorge nessuno.
 *
 * ── PERCHÉ SETTE E NON «VALIDA / NON VALIDA» ────────────────────────────────
 * Perché a chi ha appena pagato si dicono cose diverse. «Non ho una chiave con
 * cui controllare» è un guasto nostro e nessun gettone lo aggirerà; «la firma
 * non torna» è un gettone da buttare; «è per un'altra macchina» è una cosa che
 * si risolve chiedendo il gettone giusto. Appiattirli darebbe a tutti e tre la
 * stessa frase inutile, e a un problema di distribuzione la faccia di una
 * truffa.
 */

export type MotivoLicenza =
  | "no_token"            // nessun gettone installato: il caso normale, non un errore
  | "no_verification_key" // niente con cui controllare la firma → non si crede a niente
  | "malformed"           // non sono due segmenti base64url, o il carico non è JSON
  | "bad_signature"
  | "other_installation"  // firmato per un'altra macchina: copiarlo non serve
  | "expired"
  | "valid";

/**
 * Tutti e sette, elencati.
 *
 * Serve a chi deve girarci sopra — un test che controlla di avere una frase per
 * ciascuno, per esempio. Senza, quell'elenco si riscrive a mano nel test, e un
 * elenco scritto a mano è la stessa copia che il tipo condiviso ha appena
 * tolto di mezzo: resterebbe a sette mentre il tipo passa a otto, e il test
 * continuerebbe a dire di sì.
 *
 * `satisfies` lo lega al tipo: se un motivo nuovo non finisce anche qui, non
 * compila.
 */
export const MOTIVI_LICENZA = [
  "no_token", "no_verification_key", "malformed",
  "bad_signature", "other_installation", "expired", "valid",
] as const satisfies readonly MotivoLicenza[];
