import type { TerminalSessionInfo } from '../types';

/**
 * Quando un roster di terminali VUOTO va creduto, e quando no.
 *
 * IL PROBLEMA. `sessions: []` ha due significati che il tipo non distingue:
 * "non ci sono sessioni" e "non lo so ancora". Il server risponde `200 []`
 * finché `reconcileSessions` non ha finito — `Bun.serve` parte senza attenderlo —
 * quindi il secondo caso è reale a ogni riavvio, e i riavvii, quando un'altra
 * sessione tocca `server/`, arrivano uno ogni dieci secondi.
 *
 * Cosa costava confonderli: quel `[]` finiva nello stato E nella cache
 * `terminal-sessions-cache` di localStorage. Da lì una pane terminale VIVA si
 * ritrovava `sessionListed === false`, e una pane in quello stato è a un
 * riaggancio sfortunato dall'overlay "Sessione scaduta" — su una sessione che il
 * server, un istante dopo, riattacca viva.
 *
 * È la stessa lezione che il server ha già imparato per sé
 * (`server/routes/terminal.ts`, `answered.ok`: una risposta reale, anche vuota, è
 * diversa da NESSUNA risposta) e che `terminalReconcile.ts` applica alle pane
 * ("un roster vuoto non è autorevole"). Qui vale per il roster in arrivo.
 *
 * NON è un ritardo né un timeout: è un'informazione che prima non viaggiava.
 */

/** Da dove arriva il roster, e cosa il server ha detto di sé. */
export interface RosterUpdate {
  incoming: TerminalSessionInfo[];
  /**
   * `reconciled` del broadcast `terminal:sessions`. `undefined` per la fetch
   * REST, che non lo porta: il corpo è un array nudo e cambiargli forma
   * romperebbe gli altri consumatori (MCP, mobile, test).
   */
  reconciled?: boolean;
  /** Il roster che avevamo prima. Serve a non degradare ciò che già sapevamo. */
  previous: TerminalSessionInfo[];
  /** Era già stato promosso ad autorevole da un aggiornamento precedente? */
  wasAuthoritative: boolean;
}

export interface RosterDecision {
  /** Un vuoto in questo roster va creduto: si possono prendere decisioni gravi. */
  authoritative: boolean;
  /** Va scritto nello stato React, o è meglio tenere quello che avevamo? */
  accept: boolean;
  /** Va scritto nella cache di localStorage per il prossimo caricamento? */
  cache: boolean;
}

/**
 * Regole, in ordine. La prima che si applica decide.
 *
 * 1. Roster NON VUOTO → autorevole per evidenza. Nessun server inventa sessioni:
 *    se ne elenca una, quella lista viene da uno stato reale.
 * 2. Vuoto e il server dice `reconciled: true` → autorevole. È il caso legittimo
 *    "hai chiuso tutti i terminali", e va accettato o una pane morta resterebbe
 *    in eterno.
 * 3. Vuoto, niente flag, ma non avevamo NIENTE da perdere (anche il roster
 *    precedente era vuoto) → autorevole. Senza questa regola una macchina senza
 *    terminali non promuoverebbe mai il roster, e il gate resterebbe chiuso per
 *    sempre invece di aprirsi sul caso banale.
 * 4. Vuoto, niente flag, e prima avevamo delle sessioni → NON autorevole, e
 *    soprattutto NON accettato: teniamo ciò che sapevamo. È l'unico ramo che il
 *    bug attraversava, ed è quello che smette di distruggere conoscenza.
 */
export function decideRosterTrust(u: RosterUpdate): RosterDecision {
  if (u.incoming.length > 0) return { authoritative: true, accept: true, cache: true };
  if (u.reconciled === true) return { authoritative: true, accept: true, cache: true };
  if (u.previous.length === 0) return { authoritative: true, accept: true, cache: true };
  // Un vuoto sospetto non degrada né lo stato né la cache né una promozione già
  // avvenuta: il server confermerà col prossimo broadcast, che ora arriva anche
  // sulla sola promozione a riconciliato.
  return { authoritative: u.wasAuthoritative, accept: false, cache: false };
}

/** Cosa sa una pane terminale quando la sua WebSocket si è appena chiusa male. */
export interface ExpiryInput {
  /** La sessione è nel roster? Se sì la pane ritenta per sempre: è viva. */
  sessionListed: boolean;
  /** Il roster è stato confermato almeno una volta? Vedi `decideRosterTrust`. */
  rosterAuthoritative: boolean;
  /** Consecutive abnormal closes. Reset at `replay-end` - the first frame only
   *  a live session sends - and NOT at `ws.onopen`: the server accepts the
   *  upgrade for any id and refuses only afterwards, so an open followed by a
   *  refusal is one more failed attach, not a fresh start. */
  retryCount: number;
  /** Ritenti concessi anche a roster che dice "assente" (corsa boot/reconcile). */
  graceRetries: number;
}

/**
 * La pane deve dichiarare la sessione scaduta, o continuare a ritentare?
 *
 * Estratta da `SingleTerminalPane.tsx` perché è la decisione che ha prodotto
 * "Sessione scaduta" su terminali VIVI, e perché nessun test la copriva — né
 * prima né dopo il fix. Le tre uscite dal ramo "ritenta" sono tutte necessarie e
 * ognuna per una ragione diversa:
 *
 * - `sessionListed` — il roster dice che la sessione c'è: la caduta è transitoria
 *   (ricarica del server, riconcile) e la pane non deve mollare MAI.
 * - `!rosterAuthoritative` — il roster non è stato confermato: la sua assenza non
 *   prova niente. È il gate aggiunto il 2026-07-30.
 * - `retryCount <= graceRetries` — margine per la corsa in cui il roster è già
 *   arrivato ma non contiene ancora una sessione che il reconcile riattaccherà.
 *
 * L'INVARIANTE DA NON PERDERE, ed è ciò che questi test proteggono: a roster
 * CONFERMATO e sessione assente, oltre la grazia, la pane DEVE dichiarare scaduta.
 * Un fix che non ci arriva più non è un fix — nasconde una pane morta per sempre.
 */
export function shouldDeclareExpired(i: ExpiryInput): boolean {
  if (i.sessionListed) return false;
  if (!i.rosterAuthoritative) return false;
  return i.retryCount > i.graceRetries;
}
