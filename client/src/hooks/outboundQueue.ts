/**
 * La coda dei messaggi che l'umano ha scritto e che NON sono ancora arrivati al
 * server. È l'unico posto in cui vive un messaggio fra il momento in cui viene
 * scritto e quello in cui il server lo accetta: se questa coda perde una riga,
 * la perde per sempre e senza dirlo.
 *
 * Perché è un modulo a sé e non tre righe dentro `useChat`: le tre perdite che
 * questo file chiude erano tutte figlie del fatto che la coda era manipolata a
 * mano, in mezzo a un `for` asincrono, con la verità durevole (localStorage) e
 * quella di React che si rincorrevano.
 *
 *   1. Il drain faceva `clearOutboundQueue()` PRIMA di provare a spedire: la
 *      coda durevole restava vuota mentre gli item vivevano solo in una
 *      variabile locale. Una tab chiusa a metà drain li portava via tutti.
 *   2. Un item la cui sessione era occupata faceva `continue` senza rimetterlo
 *      in coda — e la coda era già stata svuotata. È il caso PIÙ probabile
 *      nell'uso reale: scrivi mentre l'agente sta ancora rispondendo.
 *   3. Gli scaduti finivano in uno stato React e basta: il banner "N messages
 *      not sent" col retry spariva al primo reload, insieme ai messaggi.
 *
 * Le regole che ne discendono, e che questo modulo rende l'unica strada:
 *
 *   - la coda durevole si tocca **per item**, mai in blocco: un item esce solo
 *     quando è stato consegnato (o deliberatamente scartato), mai "in anticipo";
 *   - un item che non si può spedire ADESSO resta dov'è. Rinviare è gratis,
 *     perdere no;
 *   - gli scaduti non evaporano: cambiano coda, e anche quella è durevole.
 *
 * Tutto qui dentro è puro: lo storage è un parametro, quindi il comportamento è
 * verificabile senza un browser (vedi `outboundQueue.test.ts`).
 */

import type { SendMessageOptions } from './useChat';

export interface QueuedMessage {
  sessionKey: string;
  content: string;
  timestamp: string;
  options?: SendMessageOptions;
  /** Id univoco: è la chiave con cui l'item esce dalla coda una volta consegnato. */
  id?: string;
}

/** Il minimo di `localStorage` che serve qui — così i test non ne hanno bisogno. */
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const OUTBOUND_QUEUE_KEY = 'messages-outbound-queue';
export const EXPIRED_QUEUE_KEY = 'messages-expired-queue';

/**
 * Un messaggio scade dopo 5 minuti in coda: oltre, l'invio automatico sorprenderebbe.
 *
 * This is the ONE deadline that expires a message, and it is measured from the
 * moment the message was written (`item.timestamp`) to the moment the drain
 * looks at it, which happens on a WebSocket reconnect. A planned server
 * restart (SIGTERM plus a boot under a minute) therefore cannot expire
 * anything: the reconnect lands about four minutes inside the window. The
 * deadline is kept at five minutes on purpose, because it does not guard
 * against downtime but against surprise: a message the person wrote and then
 * forgot must not leave on its own much later. Anything longer than a restart
 * ends up in the unsent banner, where a human decides.
 */
export const MAX_QUEUE_AGE_MS = 5 * 60 * 1000;

/**
 * Identità di un item quando `id` manca (code scritte da versioni precedenti).
 * Sessione + istante + testo: due messaggi identici scritti nello stesso
 * millisecondo sulla stessa sessione sono lo stesso messaggio.
 */
export function queueItemKey(item: QueuedMessage): string {
  return item.id ?? `${item.sessionKey} ${item.timestamp} ${item.content}`;
}

/** Lettura tollerante: una coda illeggibile vale coda vuota, mai un'eccezione. */
export function readQueue(storage: QueueStorage, key: string): QueuedMessage[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is QueuedMessage =>
        !!m && typeof m === 'object' && typeof m.sessionKey === 'string' && typeof m.content === 'string',
    );
  } catch {
    return [];
  }
}

/** Scrittura: una coda vuota rimuove la chiave invece di lasciare un `[]`. */
export function writeQueue(storage: QueueStorage, key: string, items: QueuedMessage[]): void {
  try {
    if (items.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(items));
  } catch {
    // Storage pieno o negato: non c'è niente di meglio da fare che proseguire.
    // Il messaggio resta comunque visibile in chat, marcato come in coda.
  }
}

/** Accoda in fondo. Un item con lo stesso id NON viene duplicato. */
export function enqueue(storage: QueueStorage, key: string, item: QueuedMessage): QueuedMessage[] {
  const queue = readQueue(storage, key);
  const k = queueItemKey(item);
  const next = queue.some((q) => queueItemKey(q) === k) ? queue : [...queue, item];
  writeQueue(storage, key, next);
  return next;
}

/**
 * Toglie UN item. È l'unico modo previsto per far uscire qualcosa dalla coda
 * durante un drain: si chiama dopo la consegna, non prima del tentativo.
 */
export function removeItem(storage: QueueStorage, key: string, item: QueuedMessage): QueuedMessage[] {
  const k = queueItemKey(item);
  const next = readQueue(storage, key).filter((q) => queueItemKey(q) !== k);
  writeQueue(storage, key, next);
  return next;
}

/**
 * Toglie tutti gli item di una sessione. Serve a un caso solo e legittimo: la
 * `loadHistory` ha appena visto che il server quei messaggi ce li ha già.
 */
export function removeSession(storage: QueueStorage, key: string, sessionKey: string): QueuedMessage[] {
  const next = readQueue(storage, key).filter((q) => q.sessionKey !== sessionKey);
  writeQueue(storage, key, next);
  return next;
}

/** Sposta un item dalla coda d'uscita a quella degli scaduti, in modo durevole. */
export function moveToExpired(storage: QueueStorage, item: QueuedMessage): void {
  removeItem(storage, OUTBOUND_QUEUE_KEY, item);
  enqueue(storage, EXPIRED_QUEUE_KEY, item);
}

/** Messaggio minimo che serve per decidere: è la forma di `ChatMessage` usata qui. */
export interface DecisionMessage {
  role: string;
  content?: string;
  queued?: boolean;
}

export type QueueVerdict =
  /** Spedibile adesso. */
  | { action: 'send' }
  /** Troppo vecchio: passa agli scaduti, dove l'umano decide col retry. */
  | { action: 'expire' }
  /** Non adesso — resta in coda esattamente dov'è. */
  | { action: 'defer'; reason: 'locked' }
  /** Il server ce l'ha già: toglierlo è corretto, rispedirlo sarebbe un doppione. */
  | { action: 'drop'; reason: 'delivered' | 'in-flight' };

export interface DecisionContext {
  now: number;
  /** `true` se la sessione ha già un invio in corso. */
  locked: boolean;
  /** I messaggi che il client ha per quella sessione, in ordine. */
  sessionMessages: DecisionMessage[];
  maxAgeMs?: number;
}

/**
 * Cosa farne, di questo item, adesso. L'ordine dei controlli conta:
 *
 * - la scadenza viene prima di tutto (un item vecchio non va spedito nemmeno se
 *   la sessione è libera: l'umano l'ha scritto cinque minuti fa e potrebbe non
 *   volerlo più — glielo si ripropone col retry);
 * - il dedup viene prima del lock, perché un item già consegnato va tolto dalla
 *   coda anche se la sessione è occupata: rinviarlo vorrebbe dire riproporre in
 *   eterno un messaggio che il server ha già;
 * - il lock viene per ultimo ed è l'unico esito che LASCIA l'item in coda.
 */
export function decideQueuedMessage(item: QueuedMessage, ctx: DecisionContext): QueueVerdict {
  const maxAge = ctx.maxAgeMs ?? MAX_QUEUE_AGE_MS;
  const age = ctx.now - new Date(item.timestamp).getTime();
  if (Number.isFinite(age) && age > maxAge) return { action: 'expire' };

  // Il messaggio dell'utente è già in trascritto e non è più marcato "queued":
  // vuol dire che il server l'ha preso. Da lì in poi guardo cosa lo segue.
  const idx = ctx.sessionMessages.findLastIndex(
    (m) => m.role === 'user' && m.content === item.content && !m.queued,
  );
  if (idx >= 0) {
    const after = ctx.sessionMessages.slice(idx + 1);
    if (after.some((m) => m.role === 'assistant' && m.content)) return { action: 'drop', reason: 'delivered' };
    if (after.some((m) => m.role === 'assistant') || ctx.locked) return { action: 'drop', reason: 'in-flight' };
  }

  if (ctx.locked) return { action: 'defer', reason: 'locked' };
  return { action: 'send' };
}
