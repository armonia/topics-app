/**
 * La bonifica degli orfani, come REGOLA — non come chiusura dentro il boot.
 *
 * Un riavvio del server azzera `activeStreams`, quindi lo spazzino degli stream
 * fermi non arriva più alle righe di tool rimaste appese: un `running` che gira
 * per sempre, una domanda che invita un click, un permesso che aspetta una
 * decisione che nessuno può più consegnare. Al boot si chiudono.
 *
 * ── Il risparmio, e la sua unica eccezione ──────────────────────────────────
 * Una sessione il cui figlio è ancora VIVO nel broker va lasciata stare: il suo
 * tool può ancora consegnare e la sua domanda può ancora essere risposta.
 * Bollarla «interrotta» qui è il modo in cui una domanda viva diventava un ⚠️
 * con il tasto Retry al primo hot-reload (topic:ed2070df, 3 agosto).
 *
 * Il PERMESSO è l'eccezione, e non per simmetria — per come muore. Il suo
 * rendez-vous vive in memoria e il bridge che lo pollava è figlio del figlio
 * CLI: dopo un riavvio non esiste, per costruzione, nessuno che possa
 * raccogliere quel click. E chiuderlo non può perdere una richiesta viva: se il
 * figlio è davvero lì, la sua prossima gamba di poll RIDIPINGE il pannello
 * entro 25 secondi (rotta `…/permission`). Il peggio che può fare è un lampo;
 * non chiuderlo lascia una bugia permanente.
 *
 * Successo il 7 agosto: due pannelli di permesso rimasti a schermo su turni
 * morti, con il broker che continuava a elencare la sessione. La chat chiedeva
 * un permesso che nessuno poteva più ricevere — anche dopo che l'autonomia era
 * stata messa su «libero», che è il momento in cui è diventato evidente che il
 * pannello non veniva da una richiesta nuova.
 */

/** Una riga di tool letta dal JSON persistito: forma libera, per definizione. */
export type RawToolCall = Record<string, unknown> | undefined | null;

export interface OrphanSweepOptions {
  /**
   * Il figlio di questa sessione è ancora vivo nel broker? Se sì si chiudono
   * SOLO i permessi — vedi la nota in testa.
   */
  childAlive?: boolean;
  /** Orologio iniettabile: i test misurano senza dormirci dentro. */
  now?: number;
}

export const ORPHAN_ERRORS = {
  running: 'Interrotto: la sessione è terminata prima del risultato',
  question: 'Interrotto: la sessione si è chiusa mentre la domanda era a schermo',
  permission: 'Interrotto: la sessione si è chiusa mentre il permesso era a schermo',
} as const;

/**
 * Chiude la riga se è rimasta appesa, e dice se l'ha toccata. Muta l'oggetto
 * (è la stessa struttura che poi si riserializza) e non sovrascrive un errore
 * già scritto: se qualcuno aveva già dato una spiegazione, la sua è migliore.
 */
export function finalizeOrphanTool(tc: RawToolCall, opts: OrphanSweepOptions = {}): boolean {
  if (!tc) return false;
  const alive = opts.childAlive === true;
  const now = opts.now ?? Date.now();
  const close = (message: string) => {
    tc.status = 'error';
    if (tc.endedAt == null) tc.endedAt = typeof tc.startedAt === 'number' ? tc.startedAt : now;
    if (!tc.error) tc.error = message;
    return true;
  };

  // L'unico ramo che gira anche su una sessione viva.
  if (tc.status === 'awaiting_permission') return close(ORPHAN_ERRORS.permission);
  if (alive) return false;
  if (tc.status === 'running' || tc.status === 'pending') return close(ORPHAN_ERRORS.running);
  if (tc.status === 'waiting_for_input') return close(ORPHAN_ERRORS.question);
  return false;
}
