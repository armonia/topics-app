import type { ChatMessage } from '../types';
import { HISTORY_FIRST_PAGE } from '../../../shared/history-paging';
import { decideCacheWrite } from './messageCacheWrite';
import { decideCachePrune } from './messageCachePrune';
// --- Message cache helpers (localStorage) ---
export const CACHE_PREFIX = 'messages-cache-';
// The local copy holds the FIRST PAGE of a tail-first open, message for
// message: the frame drawn from it is the frame the server's first answer
// confirms, so applying that answer moves nothing (`shared/history-paging.ts`).
// It was 50 while the server sent the whole thread; a copy longer than the
// page would shrink on the first answer, one shorter would grow.
export const CACHE_MAX_MESSAGES = HISTORY_FIRST_PAGE;

/**
 * Tetto in BYTE per voce di cache.
 *
 * `CACHE_MAX_MESSAGES` limita il NUMERO di messaggi, non la loro dimensione — e
 * un messaggio con tool call e blocchi pesa quanto cinquanta righe di testo.
 * Misurato sul localStorage vivo il 2026-07-29: una singola voce da **2.383.940
 * byte** (50 messaggi, ~47 KB l'uno), cioe' quasi meta' dell'intera quota per
 * UNA conversazione.
 */
export const CACHE_MAX_BYTES = 256 * 1024;

/**
 * Tetto complessivo all'idratazione. Sotto questo, quanta cache si porta in heap
 * al boot resta una cosa che sappiamo invece di una che scopriamo.
 */
export const CACHE_TOTAL_BUDGET = 2 * 1024 * 1024;

/**
 * SOLO le voci di cache dei messaggi.
 *
 * ATTENZIONE, e non e' teorica: `messages-cache-` e `messages-outbound-queue`
 * cominciano uguale. Un filtro su `messages-` sfoltirebbe le CODE DELL'UTENTE —
 * i messaggi scritti e non ancora consegnati — e l'header di `outboundQueue.ts`
 * dice esattamente cosa significa: "se questa coda perde una riga, la perde per
 * sempre e senza dirlo". Questo predicato esiste per non far mai quel errore.
 */
export function isCacheKey(key: string): boolean {
  return key.startsWith(CACHE_PREFIX);
}

/**
 * Libera la quota all'avvio, una volta sola.
 *
 * Il tetto per voce protegge le scritture FUTURE, ma le voci gia' su disco
 * restano dove sono: il 2026-07-29 erano 4,5 MB, e finche' nessuno le tocca la
 * quota resta satura — quindi restano rotte anche la coda dei messaggi in uscita,
 * le bozze e gli snapshot delle pane, che di quella quota hanno bisogno.
 * Aspettare "la prossima scrittura di una chat" vorrebbe dire lasciare l'utente
 * senza coda per un tempo indeterminato.
 *
 * Tocca SOLO `messages-cache-*`: vedi `isCacheKey` per il motivo, che e' il
 * pericolo piu' serio di tutto questo file.
 */
export function pruneMessageCache(): void {
  try {
    const entries = cacheEntriesBySize();
    const toRemove = decideCachePrune(entries, CACHE_TOTAL_BUDGET);
    if (toRemove.length === 0) return;
    let freed = 0;
    for (const key of toRemove) {
      freed += entries.find((e) => e.key === key)?.bytes ?? 0;
      localStorage.removeItem(key);
    }
    console.info(
      `[chat] potata la cache dei messaggi: ${toRemove.length} voci, ${Math.round(freed / 1024)} KB liberati`,
    );
  } catch {
    /* niente localStorage: non c'e' niente da potare */
  }
}

/** Le voci di cache oggi presenti, dalla piu' grossa alla piu' piccola. */
export function cacheEntriesBySize(): { key: string; bytes: number }[] {
  const out: { key: string; bytes: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isCacheKey(key)) continue;
    out.push({ key, bytes: localStorage.getItem(key)?.length ?? 0 });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Fa spazio buttando le voci di cache PIU' GROSSE.
 *
 * Le piu' grosse e non le piu' vecchie, perche' l'eta' non e' scritta da nessuna
 * parte: la voce e' un array nudo, e i due lettori la validano con
 * `Array.isArray`. Aggiungere un campo `savedAt` significherebbe cambiare lo
 * schema sotto i piedi di quei lettori e far fallire la validazione in silenzio.
 * La dimensione e' un criterio onesto: la voce che occupa mezza quota e' anche
 * quella che, ricaricandosi dal server, costa meno di quanto stava costando.
 */
export function evictCacheSpace(targetBytes: number): void {
  let freed = 0;
  for (const e of cacheEntriesBySize()) {
    if (freed >= targetBytes) break;
    try {
      localStorage.removeItem(e.key);
      freed += e.bytes;
    } catch {
      break;
    }
  }
}

/**
 * Scrive la cache di una sessione, restando dentro il proprio tetto.
 *
 * IL BUG CHE CHIUDE. Il 2026-07-29 il localStorage dell'app era a **5.245.244
 * byte contro una quota WebKit di 5.242.880**: oltre il limite. Di quei byte,
 * 4.563.206 su 22 voci erano `messages-cache-*` — l'87% della quota per una
 * cache il cui unico scopo e' mostrare la chat piu' in fretta al boot.
 *
 * E la conseguenza non era la memoria, era la PERDITA DI DATI: con la quota
 * satura ogni `setItem` dell'app falliva, e nel database non c'era traccia ne'
 * di `messages-outbound-queue` ne' di `messages-expired-queue` — le code dei
 * messaggi scritti e non ancora consegnati non erano mai state scritte. Insieme
 * a loro: bozze del composer, offset di scroll, snapshot delle pane.
 *
 * Falliva in silenzio perche' qui c'era un `catch {}` nudo. Adesso l'errore di
 * quota si riconosce, si fa spazio, e si riprova una volta.
 *
 * IL SECONDO GUASTO, misurato il 2026-08-11: la quota e' un tetto, ma il COSTO
 * non e' quanta cache tieni, e' quante volte la riscrivi. 1,52 GB di giornale
 * WAL su 3,2 GB di store WebKit, e un checkpoint su copia lo riassorbe in 5,1
 * MB: 166 volte piu' piccolo. Il tetto per voce non c'entra, perche' ogni
 * `setItem` riappende l'intero insieme di pagine toccate e WebKit non fa
 * checkpoint finche' la sessione vive. Percio' la decisione di scrivere e'
 * passata a `decideCacheWrite`, che nega le due riscritture inutili: il blob che
 * sfora il tetto anche con UN solo messaggio, e quello identico a cio' che c'e'
 * gia'. Il perche' di ognuna sta nell'intestazione di quel modulo.
 */
export function cacheMessages(sessionKey: string, msgs: ChatMessage[]) {
  const key = CACHE_PREFIX + sessionKey;

  // Si LEGGE prima di scrivere, e non e' uno spreco: `getItem` copia al massimo
  // il tetto di una voce, mentre `setItem` riappende al giornale WAL tutte le
  // pagine toccate. Il confronto e' esatto e vale anche fra finestre diverse,
  // dove una mappa in memoria non vedrebbe la scrittura dell'altra.
  let previous: string | null;
  try {
    previous = localStorage.getItem(key);
  } catch {
    return; // niente localStorage: non c'e' nessuna cache da tenere
  }

  const decision = decideCacheWrite({
    settled: msgs.filter((m) => !m.partial),
    previous,
    maxMessages: CACHE_MAX_MESSAGES,
    maxBytes: CACHE_MAX_BYTES,
  });

  if (decision.action === 'skip') return;

  if (decision.action === 'drop') {
    // Un solo messaggio piu' grande del tetto: 821 KB contro 256 KB, misurato.
    // La voce se ne va invece di restare li' a farsi riscrivere a ogni turno.
    try { localStorage.removeItem(key); } catch { /* storage negato */ }
    console.info(
      `[chat] cache dei messaggi rimossa: un singolo messaggio supera il tetto di ${Math.round(CACHE_MAX_BYTES / 1024)} KB`,
      { sessionKey },
    );
    return;
  }

  const payload = decision.payload;
  try {
    localStorage.setItem(key, payload);
  } catch {
    // `QuotaExceededError` puo' arrivare anche da voci di ALTRE origini: si fa
    // spazio fra le nostre cache e si riprova UNA volta. Se fallisce ancora, la
    // cache di questa sessione salta — ed e' l'esito giusto, perche' e' la cosa
    // meno importante che quella quota contiene.
    try {
      evictCacheSpace(Math.max(payload.length * 2, 512 * 1024));
      localStorage.setItem(key, payload);
    } catch {
      // Un warn e non il silenzio: la versione muta di questa riga ha tenuto
      // nascosto per mesi un localStorage saturo, e con lui la coda dei messaggi
      // non consegnati.
      console.warn('[chat] cache dei messaggi non scritta: localStorage pieno', {
        sessionKey,
        bytes: payload.length,
      });
    }
  }
}

export function getCachedMessages(sessionKey: string): ChatMessage[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + sessionKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearCachedMessages(sessionKey: string) {
  try { localStorage.removeItem(CACHE_PREFIX + sessionKey); } catch { /* cache entry may already be gone or storage blocked */ }
}


/**
 * Idrata la cache al boot, entro un budget.
 *
 * Prima portava in stato React TUTTO cio' che trovava: il 2026-07-29 erano 4,5 MB
 * di JSON parsati all'avvio, per conversazioni che l'utente magari non riaprira'
 * mai in quella sessione. Adesso le voci si prendono dalla piu' piccola in su
 * finche' il budget regge, e le altre restano su disco: la loro chat si
 * ricarichera' dal server all'apertura, che e' esattamente cio' che succede per
 * ogni sessione non ancora in cache.
 */
export function getInitialMessages(): Record<string, ChatMessage[]> {
  try {
    const result: Record<string, ChatMessage[]> = {};
    let budget = CACHE_TOTAL_BUDGET;
    // Dalla piu' piccola: a parita' di budget si idratano PIU' conversazioni, e
    // quella enorme e' anche quella che il server ricarica volentieri.
    const entries = cacheEntriesBySize().reverse();
    for (const { key, bytes } of entries) {
      if (bytes > budget) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      result[key.slice(CACHE_PREFIX.length)] = parsed as ChatMessage[];
      budget -= bytes;
    }
    return result;
  } catch {
    return {};
  }
}
