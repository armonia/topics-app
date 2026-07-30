/**
 * Chi va avvisato quando l'utente svuota una chat.
 *
 * Svuotare la tabella `messages` pulisce solo quello che si VEDE. Dove la
 * conversazione vive fuori da Topics, il modello continua a ricordare tutto
 * ciò che l'utente ha appena visto sparire — e lo tira fuori al primo
 * riferimento («come dicevo prima…» su una chat che sullo schermo è vuota).
 *
 * I provider sono di due architetture, e vogliono due gesti diversi:
 *
 *   • **a respawn** (claude-code): la memoria sta nel file di sessione della
 *     CLI, che il turno dopo viene ricaricato con `--resume <id>`. Va tagliato
 *     il legame con quell'id → `resetSession`.
 *   • **in banda** (openclaw): la conversazione vive nel gateway e accetta i
 *     comandi dentro la sessione stessa → si manda `/clear` con
 *     `sendToSession`.
 *
 * Prima esisteva solo il secondo ramo, chiamato in optional-call
 * (`provider.sendToSession?.(…)`): su claude-code, che quel metodo non lo ha
 * proprio, era un no-op silenzioso. Nessun errore, nessun log: solo un `/clear`
 * che non cancellava niente di ciò che conta.
 *
 * La regola sta qui, pura e testata, invece che in un `if` dentro l'handler:
 * il difetto era esattamente il tipo di cosa che un `?.` fa sparire senza
 * lasciare traccia, e questa è la rete che impedisce che ricapiti.
 */

/** Cosa fare col provider, oltre a svuotare la tabella dei messaggi. */
export type ClearProviderAction =
  /** Dimentica la sessione: il turno dopo riparte da zero. */
  | { kind: "reset" }
  /** Manda `/clear` dentro la sessione, che è viva lato server. */
  | { kind: "in-band" }
  /** Il provider non tiene memoria fuori da Topics: basta la tabella. */
  | { kind: "none" };

/** La forma minima che serve per decidere: i due metodi opzionali. */
export interface ClearCapableProvider {
  resetSession?: unknown;
  sendToSession?: unknown;
}

/**
 * Decide il gesto giusto per il provider dato.
 *
 * `resetSession` vince su `sendToSession` quando ci sono entrambi: azzerare la
 * sessione è totale e non dipende da come il provider interpreta una stringa
 * `/clear`, che a quel punto arriverebbe a una sessione già dimenticata.
 */
export function clearActionFor(provider: ClearCapableProvider | null | undefined): ClearProviderAction {
  if (typeof provider?.resetSession === "function") return { kind: "reset" };
  if (typeof provider?.sendToSession === "function") return { kind: "in-band" };
  return { kind: "none" };
}
