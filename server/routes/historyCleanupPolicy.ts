/**
 * Quando `/api/history` può considerare finito un turno — e quando NO.
 *
 * La pulizia che quel route fa a ogni caricamento non è cosmetica: cancella le
 * bolle parziali vuote e azzera il flag `partial` su tutte le altre. E `partial`
 * è il perno di tutto il resto — il setaccio di boot e il reattach leggono da lì
 * «c'è un turno in volo», e se lo trovano a zero REAPano il figlio nel broker.
 *
 * Il guasto: la domanda «sta streammando?» si faceva a una mappa IN MEMORIA
 * (`activeStreams`). Dopo un riavvio del server quella mappa è vuota anche per
 * una sessione il cui figlio è vivissimo nel broker, fermo su una domanda a
 * schermo. Un ⌘R nella finestra fra il riavvio e la riadozione bastava a
 * buttare via il turno: pannello sostituito dal cartello «No response
 * received», figlio reapato al giro dopo. Cioè esattamente il contrario di
 * quello che il broker esiste per garantire.
 *
 * Qui la decisione, pura, per poterla provare senza un broker vero.
 */

/** Cosa dice il broker del turno di questa sessione. `unknown` = non lo sa (bridge
 *  spento, daemon non raggiungibile): non è una risposta, e non autorizza niente. */
export type BrokerTurnState = "open" | "idle" | "unknown";

export interface HistoryCleanupInput {
  /** `activeStreams` ha una voce per questa sessione: turno in volo, qui e ora. */
  streamInMemory: boolean;
  /** Almeno una riga `partial = 1` in DB, cioè c'è qualcosa da perdere. */
  hasPartialRows: boolean;
  /** Il verdetto del broker, o `null` se non lo si è nemmeno chiesto. */
  brokerState: BrokerTurnState | null;
}

/**
 * Vero quando il turno va trattato come VIVO, cioè la pulizia non deve toccare
 * niente.
 *
 * Solo un `open` esplicito del broker aggiunge protezione: `idle` e `unknown`
 * lasciano il comportamento storico. È deliberato — su un host col bridge
 * spento `brokerTurnState` dice sempre `unknown`, e trattarlo come «forse vivo»
 * lascerebbe righe `partial` stantie per sempre, che è il guasto opposto.
 */
export function isTurnStillLive(input: HistoryCleanupInput): boolean {
  if (input.streamInMemory) return true;
  return input.brokerState === "open";
}

/**
 * Vale la pena chiedere al broker? Chiederlo costa un giro sul daemon e un
 * replay muto dello store, e `/api/history` lo chiama a ogni pane che monta e a
 * ogni cambio di tab. Se non c'è nessuna riga parziale la pulizia non ha niente
 * da fare comunque: si risparmia il giro e si risponde subito.
 */
export function shouldConsultBroker(input: Omit<HistoryCleanupInput, "brokerState">): boolean {
  return !input.streamInMemory && input.hasPartialRows;
}
