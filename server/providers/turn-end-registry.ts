/**
 * L'ultima fine di turno per sessione — il ponte fra chi la SA e chi la usa.
 *
 * Il provider conosce la ragione (`./stop-reason`), ma chi decide cosa farne è
 * il dispatcher, e fra i due c'è una route HTTP: il turno headless si guida
 * mandando un POST /api/chat e leggendo lo specchio SSE fino alla fine. Passare
 * la ragione lungo quel filo vorrebbe dire riparsare l'SSE dal lato che l'ha
 * appena scritto — un round-trip di serializzazione per un dato che vive nello
 * stesso processo.
 *
 * Quindi: la route DEPOSITA la fine del turno quando finalizza, il chiamante la
 * RITIRA. `takeTurnEnd` consuma: una fine letta due volte sarebbe la ragione di
 * un turno vecchio attribuita a uno nuovo, ed è esattamente l'errore che questo
 * lavoro elimina. Chi guida un turno la ritira anche PRIMA di partire, per
 * buttare via un eventuale residuo di un turno che non è passato dalla
 * finalizzazione.
 */

import type { TurnEndInfo } from "./stop-reason";

/**
 * Tetto ai residui. Solo i turni che nessuno ritira restano qui: le sessioni
 * headless ritirano sempre, quelle interattive (chat UI) mai. Senza tetto la
 * mappa crescerebbe di una riga per ogni sessione di chat mai più riaperta.
 */
const MAX_ENTRIES = 200;

/** A deposited end and the moment it was deposited. */
export interface RecordedTurnEnd {
  info: TurnEndInfo;
  atMs: number;
}

// The time travels with the end, in the same entry, so eviction drops both:
// the resume sweep needs to know whether a Stop came after the message it is
// judging or belongs to the turn before it.
const lastTurnEnd = new Map<string, RecordedTurnEnd>();

/** Deposita la fine del turno per questa sessione (sovrascrive la precedente). */
export function recordTurnEnd(sessionKey: string, info: TurnEndInfo): void {
  if (!sessionKey) return;
  // delete+set rimette la chiave in coda all'ordine di inserimento della Map,
  // così lo sfratto sotto colpisce la sessione ferma da più tempo.
  lastTurnEnd.delete(sessionKey);
  lastTurnEnd.set(sessionKey, { info, atMs: Date.now() });
  while (lastTurnEnd.size > MAX_ENTRIES) {
    const oldest = lastTurnEnd.keys().next();
    if (oldest.done) break;
    lastTurnEnd.delete(oldest.value);
  }
}

/** Ritira (e consuma) la fine del turno. `undefined` = nessuna, o già ritirata. */
/** Is an end already deposited for this session? Read without consuming: the
 *  headless drain uses it to stop waiting on a body that will never close. */
export function peekTurnEnd(sessionKey: string): boolean {
  return lastTurnEnd.has(sessionKey);
}

export function takeTurnEnd(sessionKey: string): TurnEndInfo | undefined {
  const recorded = lastTurnEnd.get(sessionKey);
  if (recorded) lastTurnEnd.delete(sessionKey);
  return recorded?.info;
}

/**
 * The last end deposited for this session and when, WITHOUT consuming it.
 *
 * For the resume sweep, which must not steal an end from a headless driver.
 * Interactive chats never withdraw, so their last end stays readable until it
 * is overwritten or evicted; after a restart the map is empty and the reader
 * gets `undefined`, which is the honest answer.
 */
export function readTurnEnd(sessionKey: string): RecordedTurnEnd | undefined {
  return lastTurnEnd.get(sessionKey);
}

/** Solo per i test: azzera tutto. */
export function resetTurnEndRegistry(): void {
  lastTurnEnd.clear();
}

/** Solo per i test/diagnostica: quante fini non ritirate ci sono. */
export function turnEndRegistrySize(): number {
  return lastTurnEnd.size;
}
