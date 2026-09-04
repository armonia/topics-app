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

const lastTurnEnd = new Map<string, TurnEndInfo>();

/** Deposita la fine del turno per questa sessione (sovrascrive la precedente). */
export function recordTurnEnd(sessionKey: string, info: TurnEndInfo): void {
  if (!sessionKey) return;
  // delete+set rimette la chiave in coda all'ordine di inserimento della Map,
  // così lo sfratto sotto colpisce la sessione ferma da più tempo.
  lastTurnEnd.delete(sessionKey);
  lastTurnEnd.set(sessionKey, info);
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
  const info = lastTurnEnd.get(sessionKey);
  if (info) lastTurnEnd.delete(sessionKey);
  return info;
}

/** Solo per i test: azzera tutto. */
export function resetTurnEndRegistry(): void {
  lastTurnEnd.clear();
}

/** Solo per i test/diagnostica: quante fini non ritirate ci sono. */
export function turnEndRegistrySize(): number {
  return lastTurnEnd.size;
}
