/**
 * L'INTENTO DI FUOCO — chi decide quale pane è a fuoco quando lo store si
 * ri-idrata, e per quanto tempo può decidere.
 *
 * Un deep-link (`/task/<id>`, `/tab/<tipo>/<chiave>`) apre una pane e poi deve
 * DIFENDERLA: la prima ondata di idratazione del pane-store rifà la
 * riconciliazione del fuoco e rimetterebbe davanti la pane di prima, rubando
 * l'attivazione al link. L'intento è quella difesa: finché è vivo, batte lo
 * stato dello store.
 *
 * Una difesa che non scade diventa un rapimento. L'intento della board viveva a
 * ciclo aperto, perché il drawer del task risponde `topics:task-opened` quando
 * si apre davvero — ma quell'ack ha tre vicoli ciechi (il task non esiste più,
 * il trasporto cade, la board non monta), e in quei casi l'intento restava
 * armato per il RESTO DELLA SESSIONE. Da lì il guasto riportato: apro un
 * progetto dalla sidebar, faccio una chat nuova, e la finestra torna sulla
 * board. Non c'entra la chat: la sottoscrizione a `lastSeq` si sveglia a OGNI
 * dispatch, quindi bastava una qualunque mutazione dello store perché
 * l'intento rimasto appeso riportasse il fuoco su `__board__`.
 *
 * Quindi: UNA sola forma di intento, con UNA scadenza, per tutti e due. L'ack
 * resta la via veloce (rilascia subito), la scadenza è la rete sotto.
 */

/** Un intento di fuoco: su quale pane, e fino a quando può ancora forzarlo. */
export type FocusIntent = { paneId: string; until: number };

/**
 * Quanto vive un intento. Otto secondi è la stessa finestra entro cui
 * `BootDeepLinkResolver` (App.tsx) ri-asserisce il deep-link al boot: oltre
 * quella la corsa di avvio è finita per definizione, e non c'è più niente da
 * difendere. Tenere l'intento vivo più a lungo della ri-asserzione che lo
 * accompagna non protegge nessuno: strattona e basta.
 */
export const FOCUS_INTENT_TTL_MS = 8000;

/** Arma un intento su `paneId`, valido a partire da `now`. */
export function armFocusIntent(paneId: string, now: number = Date.now()): FocusIntent {
  return { paneId, until: now + FOCUS_INTENT_TTL_MS };
}

/** Il pane id dell'intento se è ancora nella sua finestra, altrimenti `null`. */
export function liveFocusIntent(
  intent: FocusIntent | null,
  now: number = Date.now(),
): string | null {
  if (!intent) return null;
  return now <= intent.until ? intent.paneId : null;
}

export interface ResolveStoreFocusArgs {
  /** Il fuoco corrente lato React. */
  prev: string | null;
  /** Il fuoco secondo il pane-store. */
  storeFocus: string | null;
  /** L'ordine delle pane in `group:default` secondo lo store. */
  storeOrder: string[];
  /** Le pane di `storeOrder` visibili nello Spazio attivo, nello stesso ordine. */
  visibleOrder: string[];
  /** Intento della board, già filtrato per scadenza (`liveFocusIntent`). */
  boardIntent: string | null;
  /** Intento di un permalink di tab, già filtrato per scadenza. */
  tabIntent: string | null;
}

/**
 * Chi vince il fuoco dopo un'idratazione dello store, in ordine di precedenza:
 *
 *  1. un intento VIVO (board, poi tab) che punta a una pane davvero nell'ordine
 *     — un intento senza riscontro è inerte, non blocca niente;
 *  2. il fuoco dello store, se React non ce l'ha già uguale;
 *  3. il fuoco locale, se la sua pane esiste ancora;
 *  4. la prima pane VISIBILE nello Spazio attivo — atterrare su una nascosta
 *     farebbe strattonare la finestra su un altro Spazio al giro dopo.
 */
export function resolveStoreFocus(args: ResolveStoreFocusArgs): string | null {
  const { prev, storeFocus, storeOrder, visibleOrder, boardIntent, tabIntent } = args;
  if (boardIntent && storeOrder.includes(boardIntent)) return boardIntent;
  if (tabIntent && storeOrder.includes(tabIntent)) return tabIntent;
  if (prev === storeFocus) return prev;
  if (storeFocus && storeOrder.includes(storeFocus)) return storeFocus;
  if (prev && storeOrder.includes(prev)) return prev;
  return visibleOrder[0] ?? storeFocus ?? null;
}
