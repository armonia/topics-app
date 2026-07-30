/**
 * L'id che il SERVER ha assegnato a questa connessione WS.
 *
 * PERCHÉ ESISTE. Il frame `welcome` porta `clientId` da sempre, col commento
 * «Echo of the WS client id» — ed era completamente inutilizzato: nessun punto
 * del client leggeva quel frame. Il risultato è che un client non sapeva
 * riconoscere i propri echi, e i broadcast che portano `clientId` proprio per
 * quello (`typing`) venivano trattati come se venissero sempre da un altro.
 *
 * NON è `getTabId()` (state/pane/middleware/syncCrossTab). Quello è un id che il
 * client genera per sé e manda come header `X-Client-Id` sulle scritture REST del
 * pane-store; questo è quello che il SERVER assegna alla socket. Due spazi di id
 * diversi, per due canali diversi: confonderli fa fallire il confronto in
 * silenzio, che è il modo peggiore in cui un filtro anti-eco può rompersi.
 *
 * Modulo a sé e non uno stato React: chi deve confrontare un `clientId` sta in
 * fondo all'albero (una ChatPane fra tante) e non ha motivo di ricevere l'id come
 * prop attraverso cinque livelli. Stesso modello di `windowAwake`/`useSharedNow`.
 */

let clientId: string | null = null;

/** Registrato dal frame `welcome`, a ogni (ri)connessione: il server assegna un
 *  id nuovo per socket, quindi il valore va SOSTITUITO, non tenuto dal primo. */
export function setWsClientId(id: string | null): void {
  clientId = id && id.length > 0 ? id : null;
}

/** L'id di questa connessione, o `null` se il welcome non è ancora arrivato. */
export function getWsClientId(): string | null {
  return clientId;
}

/**
 * Questo frame l'ho mandato io?
 *
 * `false` quando l'id non si conosce ancora (welcome non arrivato) o quando il
 * frame non ne porta uno: nel dubbio si tratta come ALTRUI, perché il costo dei
 * due errori non è simmetrico — mostrare un indicatore di troppo per una frazione
 * di secondo è un fastidio, non mostrare mai l'attività di un altro utente
 * rompe la funzione.
 */
export function isOwnFrame(frameClientId: string | null | undefined): boolean {
  if (!clientId || !frameClientId) return false;
  return frameClientId === clientId;
}
