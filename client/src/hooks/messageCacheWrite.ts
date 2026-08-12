/**
 * Decidere SE e COSA scrivere nella cache dei messaggi.
 *
 * IL GUASTO CHE CHIUDE, misurato il 2026-08-11 su
 * `~/Library/WebKit/io.armonia.topics.tauri`: 1,52 GB di giornale WAL su 3,2 GB
 * di store, il 47%. Il file piu' grosso, 847 MB con mtime del giorno stesso, e'
 * la webview principale dell'app, e la sua ItemTable contiene chiavi nostre. Un
 * `PRAGMA wal_checkpoint(TRUNCATE)` su una copia lo riassorbe in 5,1 MB: 166
 * volte piu' piccolo. Quindi il giornale non e' dato, e' RUMORE DI SCRITTURA.
 *
 * L'amplificazione ha una causa sola: ogni `setItem` riappende al WAL l'intero
 * insieme di pagine toccate, e WebKit non fa checkpoint finche' la sessione
 * vive. Un blob da 1 MB riscritto 691 volte non costa 1 MB, costa 691 MB.
 *
 * Due cose lo riscrivevano senza motivo, e sono le due che questo modulo ferma:
 *
 *  1. IL TETTO CHE NON TENEVA. `cacheMessages` dimezzava la coda finche' la voce
 *     non stava nel tetto, ma il ciclo usciva a `take = 1` SENZA ricontrollare:
 *     se il singolo messaggio piu' recente da solo sfora, il blob veniva scritto
 *     lo stesso. Misurato: 821 KB contro un tetto di 256 KB. Un turno con molte
 *     tool call fa esattamente questo, e lo rifa a ogni turno.
 *
 *  2. LE RISCRITTURE IDENTICHE. `loadHistory` richiama `cacheMessages` a ogni
 *     idratazione, anche quando la storia che arriva e' bit per bit quella gia'
 *     in cache. Il codice sopra lo sapeva gia' per il RENDER (`reconcileMessages`
 *     restituisce l'array precedente e React salta il giro) ma non per il DISCO.
 *
 * La decisione sta qui, pura, perche' e' l'unico modo di provarla senza un
 * `localStorage` vero: vedi `messageCacheWrite.test.ts`, che conta i byte
 * scritti su uno storage finto.
 */

/** Cosa fare della voce di cache di questa sessione. */
export type CacheWriteDecision =
  /** Scrivi `payload`, che tiene gli ultimi `kept` messaggi. */
  | { action: 'write'; payload: string; kept: number }
  /**
   * Togli la voce: nemmeno UN messaggio ci sta nel tetto, e una voce che non
   * puo' rispettarlo non e' una cache, e' una perdita di quota.
   */
  | { action: 'drop'; reason: 'oversize' }
  /** Non toccare il disco. `identical`: c'e' gia' quel contenuto. `absent`: non c'e' niente da togliere. */
  | { action: 'skip'; reason: 'identical' | 'absent' };

export interface CacheWriteInput<T> {
  /** I messaggi da mettere in cache, gia' privati dei `partial`. */
  settled: readonly T[];
  /** Il contenuto oggi in `localStorage` per questa chiave, `null` se non c'e'. */
  previous: string | null;
  /** Quanti messaggi al massimo, prima ancora di guardare la dimensione. */
  maxMessages: number;
  /**
   * Il tetto per voce. Misurato in unita' di stringa (`String.length`), la
   * stessa unita' che usa tutto il resto del file chiamante: qui conta che il
   * numero sia confrontabile con quelli, non che sia un byte esatto.
   */
  maxBytes: number;
  /** Iniettabile solo per i test; in produzione e' `JSON.stringify`. */
  serialize?: (msgs: readonly T[]) => string;
}

/**
 * La coda piu' lunga che sta nel tetto, o il verdetto che non ce n'e' una.
 *
 * Taglia dalla CODA perche' i messaggi recenti sono quelli che l'utente si
 * aspetta di rivedere aprendo la chat. Il dimezzamento e' grossolano di
 * proposito: costa al massimo sei serializzazioni, e la voce di cache non vale
 * una ricerca binaria esatta.
 */
export function decideCacheWrite<T>(input: CacheWriteInput<T>): CacheWriteDecision {
  const { settled, previous, maxMessages, maxBytes } = input;
  const serialize = input.serialize ?? ((m: readonly T[]) => JSON.stringify(m));

  let take = Math.min(settled.length, maxMessages);
  // `slice(-0)` e' `slice(0)`, cioe' l'array INTERO: con zero messaggi il
  // risultato e' lo stesso solo perche' l'array e' vuoto. Scriverlo esplicito
  // costa una riga e toglie una trappola a chi cambiera' il tetto.
  let payload = take === 0 ? serialize([]) : serialize(settled.slice(-take));

  while (take > 1 && payload.length > maxBytes) {
    take = Math.floor(take / 2);
    payload = serialize(settled.slice(-take));
  }

  // IL CONTROLLO CHE MANCAVA. Il ciclo sopra esce a `take = 1` senza guardare
  // se quell'ultimo messaggio ci sta. Se non ci sta, non c'e' nessuna coda da
  // salvare: troncare il TESTO del messaggio darebbe una cache che mente.
  if (payload.length > maxBytes) {
    return previous === null
      ? { action: 'skip', reason: 'absent' }
      : { action: 'drop', reason: 'oversize' };
  }

  if (payload === previous) return { action: 'skip', reason: 'identical' };

  return { action: 'write', payload, kept: take };
}
