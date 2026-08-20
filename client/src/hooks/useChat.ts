import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ChatRequest, CompactionMarker, ContentBlock, HistoryMessage, Message, ToolCall, WSMessage } from '../types';
import { chatApi } from '../lib/api';
import { decideClientWipeOnStop } from './stopSessionPolicy';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { isEmptyAssistantTurn } from '../../../shared/empty-turn';
import { mergeCatchupIntoPartial, shouldAdoptIntoPlaceholder, CLIENT_MESSAGE_ID_PREFIX } from './streamCatchupMerge';
import { clearPartialForReattach } from './streamReattachReset';
import { LiveTurnIds, liveAssistantIndex, shouldFillFromBroadcast } from './liveTurn';
import { decideCacheWrite } from './messageCacheWrite';
import { decideCachePrune } from './messageCachePrune';
import { useRefMirror } from './useRefMirror';
import { reconcileMessages, mergeFetchedHistory, adoptDurableMessageId } from './reconcileMessages';
import { buildRequestMessages } from './chatRequestPayload';
import { reconcileOrphanStreams } from '../state/signals';
import { answerFromText, findPendingAsk } from '../state/pendingAsk';
import { armPushAsk } from '../state/pushAsk';
import {
  claimBatch as claimQueuedTurns,
  decideSend,
  enqueueTurn,
  getQueue as getTurnQueue,
  isHeld as isQueueHeld,
  holdQueue,
  mergeBatch,
  releaseClaim,
  releaseHold,
  requeueFront,
  unshiftTurn,
} from '../state/chatQueue';
import { registerFeatureWeight, roughBytes } from '../lib/featureWeight';
import {
  evictSessions,
  getAllMessages,
  getSessionMessagesFromStore,
  listSessions,
  replaceAllMessages,
  // Importata con l'alias storico: e' una funzione di MODULO, quindi stabile per
  // definizione — ed e' anche il motivo per cui non compare in nessuna lista di
  // dipendenze, mentre il vecchio `setMessages` di `useState` ci compariva.
  updateMessages as setMessages,
} from '../state/messageStore';
import {
  MESSAGE_MIN_IDLE_MS,
  MESSAGE_RESIDENCY_BUDGET,
  MESSAGE_RESIDENCY_MAX_IDLE_MESSAGES,
  decideMessageResidency,
  type MessageResidencyInput,
} from '../state/messageResidency';
import {
  EXPIRED_QUEUE_KEY,
  OUTBOUND_QUEUE_KEY,
  decideQueuedMessage,
  enqueue,
  moveToExpired,
  queueItemKey,
  readQueue,
  removeItem as removeQueueItem,
  removeSession as removeQueueSession,
  writeQueue,
  type QueueStorage,
  type QueuedMessage,
} from './outboundQueue';

// --- Message cache helpers (localStorage) ---
const CACHE_PREFIX = 'messages-cache-';
const CACHE_MAX_MESSAGES = 50;

// The chat pane always loads the COMPLETE thread — never a fixed window. The
// old value here was 100: any topic past 100 messages loaded only its most
// recent 100, its head silently vanished, and the chat rendered "tagliata"
// (starting mid-conversation) with no way to recover the beginning. A limit of
// 0 tells the server "no cap, return the whole conversation" (see history.ts
// `wantsAll`); pagination (positive limit / offset) stays available for callers
// that opt into it, but the chat never truncates.
const HISTORY_FETCH_ALL = 0;

/**
 * Ogni quanto passa lo spazzino dei trascritti. Mezzo minuto: la grazia della
 * politica è di un minuto, quindi nulla può essere sfrattato prima di averla
 * superata, e il costo di un giro è contare le chiavi di un oggetto.
 */
const SWEEP_EVERY_MS = 30_000;

/**
 * Quante sessioni lo spazzino ha restituito da quando la finestra è aperta.
 * Serve alla sonda di memoria: senza, «entries: 7» non distingue «poche chat
 * aperte» da «ne ho aperte cento e le sto potando».
 */
let sweptSessions = 0;

// Dopo tre minuti di silenzio si va a CHIEDERE al server se il turno è ancora
// vivo. Non si spegne a scadenza: il silenzio non vuol dire morte.
//
// Un auto-compact della CLI tace fino a 188 secondi — è documentato, ed è la
// ragione per cui il server estende il proprio grace fino a mezz'ora quando il
// processo è vivo (`STREAM_GRACE_MS` in routes/chat.ts). Spegnere qui a 180 s
// contraddiceva frontalmente quel fix: in ogni finestra che osserva via WS — la
// seconda finestra, la PWA sul telefono, e la stessa dopo un ⌘R — il turno vivo
// risultava finito, il bottone Stop spariva, l'aura si spegneva, e la coda
// visibile veniva scaricata in mezzo al turno.
const STREAM_TIMEOUT_MS = 3 * 60 * 1000;

// Quanto aspettiamo che il nostro SSE si chiuda da solo dopo che il server ha
// annunciato la fine del turno via WS. Nel caso sano `[DONE]` arriva nello
// stesso momento; questa finestra serve solo a non abortire un drain lento.
const SSE_FAILSAFE_MS = 5000;

const generateMessageId = () => `${CLIENT_MESSAGE_ID_PREFIX}${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Topic/project/browser control moved from {{...}} markers to MCP/SDK tools,
// so the model no longer emits markers and stored history was backfilled clean.
// This is now a no-op kept at the call sites as a thin seam (cheap identity) in
// case any legacy content needs future normalisation.
const cleanInvisibleMarkers = (text: string): string => text;

// Filter out internal gateway context messages
const isContextMessage = (content: string): boolean => {
  return content.startsWith('[Chat messages since your last reply');
};

export interface SendMessageOptions {
  /**
   * Fast Mode flag for this turn. Forwarded as `chatRequest.fastMode`; the
   * server resolves the actual model via `getFastModelFor(provider.name)`.
   * Picker (`options.model`) wins over fast — see openspec change
   * `chat-fast-mode`.
   */
  fastMode?: boolean;
  provider?: string;
  model?: string;
  /**
   * La chiave con cui il server riconosce che questo invio è LO STESSO di prima.
   *
   * Si conia una volta per messaggio e sopravvive ai tentativi: l'invio diretto
   * la genera, la coda durevole la conserva (è l'`id` dell'item) e il drain la
   * rimanda identica. È l'unica cosa che distingue «il server non l'ha mai
   * ricevuto» da «l'ha ricevuto e la connessione è caduta dopo» — due casi che
   * da qui sono indistinguibili, e che chiedono l'opposto l'uno dall'altro.
   */
  clientMessageId?: string;
}

export type { QueuedMessage };

/**
 * Tetto in BYTE per voce di cache.
 *
 * `CACHE_MAX_MESSAGES` limita il NUMERO di messaggi, non la loro dimensione — e
 * un messaggio con tool call e blocchi pesa quanto cinquanta righe di testo.
 * Misurato sul localStorage vivo il 2026-07-29: una singola voce da **2.383.940
 * byte** (50 messaggi, ~47 KB l'uno), cioe' quasi meta' dell'intera quota per
 * UNA conversazione.
 */
const CACHE_MAX_BYTES = 256 * 1024;

/**
 * Tetto complessivo all'idratazione. Sotto questo, quanta cache si porta in heap
 * al boot resta una cosa che sappiamo invece di una che scopriamo.
 */
const CACHE_TOTAL_BUDGET = 2 * 1024 * 1024;

/**
 * SOLO le voci di cache dei messaggi.
 *
 * ATTENZIONE, e non e' teorica: `messages-cache-` e `messages-outbound-queue`
 * cominciano uguale. Un filtro su `messages-` sfoltirebbe le CODE DELL'UTENTE —
 * i messaggi scritti e non ancora consegnati — e l'header di `outboundQueue.ts`
 * dice esattamente cosa significa: "se questa coda perde una riga, la perde per
 * sempre e senza dirlo". Questo predicato esiste per non far mai quel errore.
 */
function isCacheKey(key: string): boolean {
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
function pruneMessageCache(): void {
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
function cacheEntriesBySize(): { key: string; bytes: number }[] {
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
function evictCacheSpace(targetBytes: number): void {
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
function cacheMessages(sessionKey: string, msgs: ChatMessage[]) {
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

function getCachedMessages(sessionKey: string): ChatMessage[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + sessionKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearCachedMessages(sessionKey: string) {
  try { localStorage.removeItem(CACHE_PREFIX + sessionKey); } catch {}
}

/**
 * Adattatore verso `localStorage` per le due code di `outboundQueue.ts`. I
 * metodi risolvono `localStorage` alla chiamata, non alla definizione: dove non
 * esiste, l'errore cade nel try/catch del modulo invece che all'import.
 */
const queueStorage: QueueStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

/**
 * Identità di QUESTA finestra per le prenotazioni della coda del turno. Non è
 * il `clientId` del WS di proposito: quello arriva col frame `welcome`, cioè
 * dopo, e un drain nei primi istanti di vita della pagina resterebbe senza
 * identità. Qui serve solo che due finestre non si scambino il nome.
 */
const CLAIM_CLIENT_ID = (() => {
  try { return crypto.randomUUID(); } catch { return `w-${Math.random().toString(36).slice(2)}-${Date.now()}`; }
})();

/** Ritenta del drain quando la sessione è ancora occupata: 10 × 200 ms = 2 s. */
const TURN_DRAIN_RETRY_MS = 200;
const TURN_DRAIN_MAX_ATTEMPTS = 10;

const getOutboundQueue = (): QueuedMessage[] => readQueue(queueStorage, OUTBOUND_QUEUE_KEY);
const getExpiredQueue = (): QueuedMessage[] => readQueue(queueStorage, EXPIRED_QUEUE_KEY);

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
function getInitialMessages(): Record<string, ChatMessage[]> {
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

// Shared stable empty array so getSessionMessages returns a reference-equal
// result for a session with no messages (a fresh `[]` per call would be a cache
// miss every time and hand consumers a new identity each render).

let messageStoreHydrated = false;

/**
 * Lo specchio dei messaggi per le closure, senza piu' uno specchio.
 *
 * Prima era `useRefMirror(messages)`, cioe' una ref riallineata a ogni render
 * per evitare che una closure leggesse un valore vecchio. Adesso lo store E' la
 * fonte fresca: `getAllMessages()` restituisce l'ultimo valore al momento della
 * chiamata, che e' esattamente cio' che quello specchio inseguiva — e senza il
 * render di ritardo che uno specchio ha per costruzione.
 *
 * A livello di MODULO e non dentro l'hook: legge da uno store globale, quindi
 * non ha ragione di essere per-istanza, e un oggetto ricreato a ogni render
 * destabilizzerebbe le quattro callback che lo hanno fra le dipendenze.
 */
const messagesRef = {
  get current(): Record<string, ChatMessage[]> {
    return getAllMessages();
  },
};

/**
 * Applica una patch a UNA riga di tool sull'ultimo messaggio assistant che la
 * contiene, in ENTRAMBI i posti dove può vivere.
 *
 * Il difetto che chiude: i gestori scritti prima cercavano la riga dentro
 * `msgs[i].toolCalls` e patchavano i blocchi solo dopo averla trovata lì. Ma un
 * messaggio caricato dall'API può avere i `blocks` e non `toolCalls` — e in quel
 * caso il ciclo non entrava nemmeno, quindi l'evento arrivava, il gestore girava
 * e non succedeva niente. Visto il 7 agosto sul permesso: il frame nella spia
 * del WebSocket, il pannello ancora a schermo.
 */
function patchToolCallInMessages(
  msgs: ChatMessage[],
  toolCallId: string,
  patch: (tc: ToolCall) => ToolCall,
): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const inCalls = (m.toolCalls ?? []).some((t) => t.id === toolCallId);
    const inBlocks = (m.blocks ?? []).some((b) => b.kind === 'tool' && b.toolCall.id === toolCallId);
    if (!inCalls && !inBlocks) continue;
    // Una sola applicazione della patch: i due contenitori devono finire con lo
    // STESSO oggetto, o si rimette in piedi la divergenza che stiamo chiudendo.
    const source =
      (m.toolCalls ?? []).find((t) => t.id === toolCallId) ??
      (m.blocks ?? []).flatMap((b) => (b.kind === 'tool' && b.toolCall.id === toolCallId ? [b.toolCall] : []))[0];
    if (!source) continue;
    const next = patch(source);
    const nextCalls = m.toolCalls?.map((t) => (t.id === toolCallId ? next : t));
    const nextBlocks = m.blocks?.map((b) =>
      b.kind === 'tool' && b.toolCall.id === toolCallId ? { kind: 'tool' as const, toolCall: next } : b,
    );
    const out = msgs.slice();
    out[i] = { ...m, ...(nextCalls ? { toolCalls: nextCalls } : {}), ...(nextBlocks ? { blocks: nextBlocks } : {}) };
    return out;
  }
  return msgs;
}

export function useChat() {
  // I messaggi NON sono piu' stato di questo hook, e quindi non sono piu' stato
  // di `App`, che e' dove `useChat` viene chiamato. Vivono in uno store di
  // modulo con sottoscrizione PER SESSIONE (`state/messageStore.ts`): chi guarda
  // una chat si sveglia solo per quella, e la radice non si sveglia affatto.
  //
  // `updateMessages` ha di proposito la stessa firma dell'updater di `useState`,
  // quindi i venticinque `setMessages` qui sotto non cambiano di una riga.
  // Le letture passano da `getAllMessages()`, che e' sincrona: dentro una
  // callback e' anche piu' corretto di prima, perche' legge sempre l'ultimo
  // valore invece di quello catturato alla creazione della closure.
  // Idratazione una volta sola, al primo `useChat` della pagina. Prima era
  // l'initializer di `useState`; adesso lo store nasce vuoto e si riempie qui.
  if (!messageStoreHydrated) {
    messageStoreHydrated = true;
    replaceAllMessages(getInitialMessages());
  }
  // Compaction dividers per session (CHAT-COMPACT-01): display-only, merged
  // into the transcript by afterMessageId in MessageList. Populated live via
  // stream:compaction and on reload from /api/history.
  const [compactionMarkers, setCompactionMarkers] = useState<Record<string, CompactionMarker[]>>({});

  // Libera la quota di localStorage all'avvio: il tetto per voce protegge le
  // scritture future, ma cio' che e' gia' su disco resta li' — e con la quota
  // piena restano rotte la coda dei messaggi in uscita, le bozze e gli snapshot
  // delle pane.
  useEffect(() => { pruneMessageCache(); }, []);

  // Si dichiara alla sonda di memoria. `messages` e' UN oggetto indicizzato per
  // sessionKey che vive in `App`: il tetto di residenza smonta la pane, ma i
  // messaggi restano qui. Se questa e' la ragione per cui il renderer principale
  // teneva 1844 MB, e' qui che si vede — e si vede come CONTEGGIO che sale senza
  // mai scendere, che e' un dato esatto, non una stima.
  // Costo a riposo: una voce in una Map. La funzione gira solo a sonda armata.
  const heapMarkersRef = useRef(compactionMarkers);
  heapMarkersRef.current = compactionMarkers;
  useEffect(() => registerFeatureWeight('chat.messages', 'Chat caricate in memoria', 'trattenuto', () => {
    const m = getAllMessages();
    const keys = Object.keys(m);
    let items = 0;
    let biggestKey = '';
    let biggest = 0;
    for (const k of keys) {
      const n = m[k]?.length ?? 0;
      items += n;
      if (n > biggest) { biggest = n; biggestKey = k; }
    }
    return {
      entries: keys.length,
      items,
      bytes: roughBytes(m),
      detail: {
        sessioneMaggiore: biggestKey,
        messaggiNellaMaggiore: biggest,
        markerBytes: roughBytes(heapMarkersRef.current),
        // Senza questo, `entries: 7` non distingue «ho aperto sette chat» da
        // «ne ho aperte cento e lo spazzino le sta restituendo».
        sessioniSfrattate: sweptSessions,
      },
    };
  }), []);
  const upsertMarker = useCallback((sessionKey: string, marker: CompactionMarker) => {
    setCompactionMarkers(prev => {
      const list = prev[sessionKey] || [];
      const idx = list.findIndex(m => m.id === marker.id);
      if (idx >= 0) {
        // Merge — a follow-up broadcast backfills postTokens onto an existing
        // marker (pre→post delta). No-op if nothing actually changed.
        const merged = { ...list[idx], ...marker };
        if (merged.postTokens === list[idx].postTokens && merged.preTokens === list[idx].preTokens) return prev;
        const next = list.slice();
        next[idx] = merged;
        return { ...prev, [sessionKey]: next };
      }
      return { ...prev, [sessionKey]: [...list, marker] };
    });
  }, []);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [streaming, setStreaming] = useState<Record<string, boolean>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  /**
   * Sessioni fermate a mano, finché non riparte un turno.
   *
   * Senza questo, «ferma» e «la connessione è caduta» arrivano al composer
   * identici — ultimo messaggio dell'utente, nessuno stream — e il banner
   * accusava la rete di una cosa che aveva fatto l'umano un secondo prima. Non
   * si deduce dai messaggi: uno stop precoce cancella la bolla vuota
   * (`dropEmptyTurn`) e lascia in pagina esattamente la stessa forma di un
   * turno mai arrivato.
   */
  const [stoppedByUser, setStoppedByUser] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [gatewayConnected, setGatewayConnected] = useState(true); // Assume connected until told otherwise
  const [orphanedSessions, setOrphanedSessions] = useState<Set<string>>(new Set());
  const [cachedSessions, setCachedSessions] = useState<Set<string>>(new Set());
  const [pendingQueue, setPendingQueue] = useState<QueuedMessage[]>(getOutboundQueue);
  // Gli scaduti si idratano dallo storage, non partono vuoti: il banner "N
  // messages not sent" col retry deve sopravvivere al reload, altrimenti la
  // scadenza equivale a buttare via il messaggio senza dirlo.
  const [expiredMessages, setExpiredMessages] = useState<QueuedMessage[]>(getExpiredQueue);
  /**
   * Un turno riparte: streaming acceso e lo stop precedente non conta più.
   * Sta qui in alto perché la usa anche il gestore degli eventi WS, che è
   * dichiarato prima di metà di questo file.
   */
  const beginStreaming = useCallback((sessionKey: string) => {
    setStreaming(prev => ({ ...prev, [sessionKey]: true }));
    setStoppedByUser(prev => (prev[sessionKey] ? { ...prev, [sessionKey]: false } : prev));
  }, []);
  const abortControllersRef = useRef<Record<string, AbortController>>({});
  const wsHandlersRef = useRef<Set<(event: WSMessage) => void>>(new Set());
  const streamingTimeoutRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /**
   * sessionKey → id della riga che il turno IN VOLO sta scrivendo, annunciato da
   * `stream:start`. Vive quanto il turno.
   *
   * È la guardia di `addMessage`: mentre un turno è aperto arrivano dei
   * `message:new` che NON sono la sua fine — l'uscita di un sotto-agente, per
   * dirne una (`server/lib/subagent-watch.ts` la scrive e la trasmette come una
   * riga qualsiasi). Il ramo che fonde la riga persistita nel segnaposto
   * guardava solo la POSIZIONE («l'ultimo messaggio è un assistant parziale»),
   * quindi la scambiava per la conclusione del turno: il rapporto del
   * sotto-agente si mangiava id, testo e bandiera della bolla viva, e tutto il
   * resto del turno finiva incollato sotto quel rapporto.
   *
   * Il nome si DIMENTICA su ogni strada per cui un turno muore, non solo su
   * `stream:end`/`stream:error`: watchdog, riconciliazione degli stream orfani,
   * stop dell'utente, sfratto delle cache, e in cima a un invio nuovo. Un nome
   * sopravvissuto al suo turno fa scrivere la risposta SUCCESSIVA dentro la
   * bolla morta. Vedi `liveTurn.ts`.
   */
  const streamMessageIdRef = useRef<LiveTurnIds>(new LiveTurnIds());
  // Watchdog per il caso "il server ha finito, il nostro SSE no": vedi
  // scheduleSSEFailsafe.
  const sseFailsafeRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // `loadHistory` è definito molto più in basso: il failsafe lo raggiunge da
  // qui senza dipendere dall'ordine di dichiarazione.
  const loadHistoryRef = useRef<((sk: string) => Promise<boolean>) | null>(null);
  // Track sessions with active local SSE streams (to avoid double content from WS broadcast)
  const localSSESessionsRef = useRef<Set<string>>(new Set());
  // Per-session timestamp of the last successful loadHistory fetch. Used to
  // dedup rapid re-mounts (a tab switch in StandaloneChatGroup unmounts the
  // active ChatPane and re-mounts a new one — without dedup the user sees
  // the loading spinner flash + a network round-trip every time they come
  // back to a chat they've just visited). WS broadcasts keep the cache
  // fresh between fetches, so a short skip window is safe. After the
  // window elapses the next mount refetches normally.
  const lastHistoryFetchAtRef = useRef<Map<string, number>>(new Map());
  // Sessions with a loadHistory request in flight RIGHT NOW. The timestamp
  // dedup above only blocks SEQUENTIAL re-fetches (it's written after the await
  // resolves), so on WS reconnect the per-panel loop + ChatPane's mount effect
  // can fire two concurrent fetches for the same session in one tick. This
  // collapses those onto one request.
  const inFlightHistoryRef = useRef<Set<string>>(new Set());
  const HISTORY_DEDUP_MS = 5_000;
  // Per-session cache of the context-filtered message view. getSessionMessages is
  // called in the render body of EVERY mounted ChatPane (StandaloneChatGroup keeps
  // visited panes mounted), so a fresh `.filter()` array per call re-ran the filter
  // for every pane on every stream token AND handed MessageList a new array
  // reference each render, defeating its `useMemo([currentMessages])`. Cache keyed
  // on the session's own array identity: setMessages does `{...prev,[key]:next}`,
  // so a session that DIDN'T change keeps the same array reference — making this a
  // reference-stable result until that session's messages actually change.
  const filteredMessagesCacheRef = useRef<Map<string, { src: ChatMessage[]; out: ChatMessage[] }>>(new Map());
  // Sessions whose `messages[sessionKey]` map has been populated at least
  // once from the server's authoritative history endpoint (or an equivalent
  // server-truth path like editMessage's post-edit thread reload). Until
  // that's true the local user-message count is not reliable, and we MUST
  // NOT use it to decide whether `stopSession` is allowed to wipe the
  // conversation. See `stopSessionPolicy.ts` for the full rationale.
  const hydratedSessionsRef = useRef<Set<string>>(new Set());
  // Per-session send lock — prevents concurrent sendMessage calls for the same session
  // Stores timestamp of lock acquisition; auto-expires after SEND_LOCK_TIMEOUT_MS
  const sendLockRef = useRef<Map<string, number>>(new Map());
  const SEND_LOCK_TIMEOUT_MS = 60_000; // 60s — auto-release stale locks
  // Helpers for send lock with auto-expiry
  const isSendLocked = (sk: string) => {
    const t = sendLockRef.current.get(sk);
    if (!t) return false;
    if (Date.now() - t > SEND_LOCK_TIMEOUT_MS) {
      console.warn(`[useChat] Auto-releasing stale send lock for ${sk} (>${SEND_LOCK_TIMEOUT_MS}ms)`);
      sendLockRef.current.delete(sk);
      return false;
    }
    return true;
  };
  const acquireSendLock = (sk: string) => sendLockRef.current.set(sk, Date.now());
  const releaseSendLock = (sk: string) => sendLockRef.current.delete(sk);
  // DrainQueue concurrency guard
  const drainingRef = useRef(false);


  // Live mirror of the streaming map so the server-reconciler (below) reads the
  // freshest flags without being re-created on every streaming change.
  const streamingRef = useRefMirror(streaming);
  // Per-session count of consecutive polls where the server said "not streaming"
  // while we still showed it streaming. Drives the orphan-clear threshold.
  const streamMissRef = useRef<Map<string, number>>(new Map());
  // Ref for sendMessage to allow stream:end to trigger next queued message
  const sendMessageRef = useRef<((sk: string, content: string, opts?: SendMessageOptions) => Promise<boolean>) | null>(null);
  // Il drain della coda del turno si richiama da sé (ritenta se la sessione è
  // ancora occupata) e viene chiamato da `stream:end`, che è definito più su.
  const drainTurnQueueRef = useRef<((sk: string, attempt?: number) => void) | null>(null);

  const resetStreamTimeout = useCallback((sessionKey: string) => {
    // Clear existing timeout
    if (streamingTimeoutRef.current[sessionKey]) {
      clearTimeout(streamingTimeoutRef.current[sessionKey]);
    }
    // Set new timeout
    streamingTimeoutRef.current[sessionKey] = setTimeout(() => {
      // Il silenzio da solo non decide: si chiede al server, che è l'unico a
      // sapere se il processo è ancora lì. La stessa fonte che alimenta la
      // riconciliazione degli stream orfani (`reconcileServerStreams`), usata qui
      // per una singola sessione.
      void (async () => {
        let serverSaysLive = false;
        try {
          const res = await fetch('/api/topics/streaming');
          if (res.ok) {
            const body = (await res.json()) as { sessions?: { sessionKey?: string; state?: string }[] };
            // `waiting` è vivo quanto `streaming`: il turno è aperto, ferma solo
            // ad aspettare una risposta. Ed è silenzioso per definizione — se lo
            // contassimo come morto, ogni domanda a schermo spegnerebbe la chat
            // allo scadere del timeout.
            serverSaysLive = (body.sessions ?? []).some((x) => x.sessionKey === sessionKey && (x.state === 'streaming' || x.state === 'waiting'));
          } else {
            // Server irraggiungibile: NON è una prova di morte. Si riarma e si
            // riprova, invece di spegnere lo stato di un turno che magari corre.
            serverSaysLive = true;
          }
        } catch {
          serverSaysLive = true;
        }
        if (serverSaysLive) {
          console.warn(`[useChat] ${sessionKey} silenzioso da ${STREAM_TIMEOUT_MS / 1000}s ma il server lo dà ancora vivo — riarmo`);
          resetStreamTimeoutRef.current(sessionKey);
          return;
        }
        console.warn(`[useChat] Stream timeout for ${sessionKey}, auto-clearing (server: non più in streaming)`);
        // Il turno è morto senza `stream:end`: il nome della sua bolla muore con
        // lui, o il turno DOPO scriverà lì dentro invece che nel segnaposto nuovo.
        streamMessageIdRef.current.end(sessionKey);
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setLoading(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
      })();
    }, STREAM_TIMEOUT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `resetStreamTimeoutRef` NON può stare qui: è dichiarato tre righe più sotto, quindi valutare l'array di dipendenze lo leggerebbe nella sua temporal dead zone. Il corpo della callback lo legge invece quando il timer scatta, a dichiarazione avvenuta — ed è tutto il punto dello specchio. Il ref è comunque stabile (useRefMirror restituisce sempre lo stesso oggetto), quindi non sarebbe una dipendenza reale.
  }, []);
  // La callback si riarma da sé: lo specchio rompe il ciclo di dichiarazione, con
  // l'helper che questo file usa già per lo stesso scopo.
  const resetStreamTimeoutRef = useRefMirror(resetStreamTimeout);

  const clearStreamTimeout = useCallback((sessionKey: string) => {
    if (streamingTimeoutRef.current[sessionKey]) {
      clearTimeout(streamingTimeoutRef.current[sessionKey]);
      delete streamingTimeoutRef.current[sessionKey];
    }
  }, []);

  const clearSSEFailsafe = useCallback((sessionKey: string) => {
    const t = sseFailsafeRef.current[sessionKey];
    if (t) {
      clearTimeout(t);
      delete sseFailsafeRef.current[sessionKey];
    }
  }, []);

  /**
   * L'ultima rete di sicurezza contro la chat che resta a caricare per sempre.
   *
   * Mentre il nostro SSE è in volo scartiamo gli eventi WS della stessa
   * sessione (sotto, in handleStreamEvent) per non contare due volte lo stesso
   * contenuto — e il reconciler degli stream orfani salta le sessioni con SSE
   * locale. Vuol dire che il turno lo chiude SOLO la risposta HTTP. Se quella
   * resta aperta senza mai mandare `[DONE]` — è successo: il watchdog
   * `[StaleStream]` lato server finalizzava il turno in DB e broadcastava
   * `stream:end`, ma non aveva modo di chiudere la risposta — il lettore resta
   * fermo su `read()` e lo spinner gira finché non ricarichi la pagina.
   *
   * Qui il `stream:end` via WS torna a valere qualcosa: non lo processiamo (lo
   * farebbe due volte), ma lo prendiamo come "il server ha finito". Diamo
   * all'SSE una finestra breve per chiudersi da solo — nel caso normale
   * `[DONE]` arriva subito dopo — e se non chiude abortiamo il fetch. L'abort
   * passa dal ramo AbortError di sendMessage, che finalizza il messaggio senza
   * errori; poi ricarichiamo la history per prendere dal server il testo
   * definitivo del turno.
   */
  const scheduleSSEFailsafe = useCallback((sessionKey: string) => {
    if (sseFailsafeRef.current[sessionKey]) return; // già in attesa
    sseFailsafeRef.current[sessionKey] = setTimeout(() => {
      delete sseFailsafeRef.current[sessionKey];
      if (!localSSESessionsRef.current.has(sessionKey)) return; // l'SSE ha chiuso da sé
      console.warn(`[useChat] server ha chiuso il turno ma l'SSE è ancora aperto su ${sessionKey} — abort del fetch`);
      abortControllersRef.current[sessionKey]?.abort();
      loadHistoryRef.current?.(sessionKey);
    }, SSE_FAILSAFE_MS);
  }, []);

  // On unmount, clear any outstanding stream watchdog timers and abort in-flight
  // SSE requests so neither leaks past the hook's lifetime.
  useEffect(() => () => {
    for (const id of Object.values(streamingTimeoutRef.current)) clearTimeout(id);
    for (const id of Object.values(sseFailsafeRef.current)) clearTimeout(id);
    for (const c of Object.values(abortControllersRef.current)) c.abort();
  }, []);

  /**
   * Reconcile our local `streaming` flags against the server's authoritative
   * streaming registry (the sessionKeys from GET /api/topics/streaming, fed in
   * by useSignalsSync's poll). Clears a chat's spinner that got stuck `true`
   * because its terminal `stream:end` was lost (WS dropped mid-stream) — the
   * server long since finished, so the client must stop showing it as in
   * progress. Own in-flight SSE sends are skipped, and a session must be absent
   * for ≥2 consecutive polls before we clear it, so a genuinely-live stream is
   * never killed. See reconcileOrphanStreams for the decision logic.
   */
  const reconcileServerStreams = useCallback((serverStreamingSessionKeys: Set<string>) => {
    const localActive: string[] = [];
    for (const [sk, on] of Object.entries(streamingRef.current)) if (on) localActive.push(sk);
    if (localActive.length === 0) {
      if (streamMissRef.current.size) streamMissRef.current = new Map();
      return;
    }
    const { orphans, nextMiss } = reconcileOrphanStreams(
      localActive,
      serverStreamingSessionKeys,
      localSSESessionsRef.current,
      streamMissRef.current,
    );
    streamMissRef.current = nextMiss;
    if (orphans.length === 0) return;
    console.warn('[useChat] clearing orphaned stream flag(s) — server no longer streaming:', orphans);
    // Stesso motivo del watchdog: qui si dichiara morto un turno che non ha mai
    // mandato la sua fine, quindi il nome della bolla in volo va dimenticato.
    for (const sk of orphans) { clearStreamTimeout(sk); streamMessageIdRef.current.end(sk); }
    setStreaming(prev => { const next = { ...prev }; for (const sk of orphans) next[sk] = false; return next; });
    setLoading(prev => { const next = { ...prev }; for (const sk of orphans) next[sk] = false; return next; });
    setThinking(prev => { const next = { ...prev }; for (const sk of orphans) next[sk] = false; return next; });
  }, [clearStreamTimeout, streamingRef]);

  const addMessage = useCallback((sessionKey: string, message: Omit<ChatMessage, 'id'> & { id?: string }) => {
    const newMessage: ChatMessage = {
      ...message,
      id: message.id || generateMessageId(),
    };

    setMessages(prev => {
      const existing = prev[sessionKey] || [];
      // Dedupe by stable id (cross-window message:new + history fetch races).
      //
      // Ma il doppione NON è sempre un no-op: da quando il segnaposto nasce con
      // l'id durevole annunciato da `stream:start`, questo confronto scatta anche
      // sulla bolla VIVA — e la riga persistita che arriva a fine turno è l'unica
      // occasione di riempirla per una finestra che le delta non le ha mai viste
      // (i `stream:content_chunk` viaggiano solo agli iscritti della topic,
      // `server/lib/ws-topic-routing.ts`). Prima ci pensava il ramo di adozione
      // qui sotto, che ora non viene più raggiunto. Vedi `shouldFillFromBroadcast`.
      const dupIndex = newMessage.id ? existing.findIndex(m => m.id === newMessage.id) : -1;
      if (dupIndex >= 0) {
        const held = existing[dupIndex];
        if (!shouldFillFromBroadcast(held, newMessage.content ?? '')) return prev;
        const updated = [...existing];
        updated[dupIndex] = { ...held, content: newMessage.content, partial: false };
        return { ...prev, [sessionKey]: updated };
      }
      // Viewer-side reconcile: when a turn driven by ANOTHER client ends, the
      // server broadcasts the PERSISTED assistant row (message:new, durable
      // id) while this window still holds the WS-stream placeholder (partial,
      // client-generated id) — so the id dedupe above can't match. Appending
      // would duplicate the reply and orphan the placeholder on "Streaming…"
      // forever. Merge into the placeholder instead: adopt the durable id and
      // final content, keep the streamed blocks/toolCalls (the broadcast
      // carries text only). Gated on `message.id` so synthetic id-less adds
      // (e.g. agents:spawned markers) never clobber an in-flight placeholder.
      //
      // E gatato sull'IDENTITÀ, non sulla posizione: vedi
      // `shouldAdoptIntoPlaceholder` per la riga di sotto-agente che si mangiava
      // la bolla viva.
      const last = existing[existing.length - 1];
      if (last && shouldAdoptIntoPlaceholder({
        incomingId: message.id,
        incomingRole: newMessage.role,
        last,
        streamingMessageId: streamMessageIdRef.current.get(sessionKey),
      })) {
        const updated = [...existing];
        updated[existing.length - 1] = { ...last, id: newMessage.id, content: newMessage.content, partial: false };
        return { ...prev, [sessionKey]: updated };
      }
      return {
        ...prev,
        [sessionKey]: [...existing, newMessage],
      };
    });

    return newMessage;
  }, []);

  const updateLastMessage = useCallback((sessionKey: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = liveAssistantIndex(sessionMessages, streamMessageIdRef.current.get(sessionKey));

      if (lastMessageIndex >= 0) {
        const updatedMessages = [...sessionMessages];
        updatedMessages[lastMessageIndex] = {
          ...updatedMessages[lastMessageIndex],
          ...updates,
        };

        return {
          ...prev,
          [sessionKey]: updatedMessages,
        };
      }

      return prev;
    });
  }, []);

  /**
   * Toglie dalla chat la bolla di un turno che non ha prodotto NIENTE — quella
   * che restava quando si premeva stop prima che il modello dicesse qualcosa.
   *
   * Per id quando il server ce lo dice (`stream:end.discardedMessageId`), con
   * ripiego sull'ULTIMA bolla: in una finestra che sta solo guardando il turno
   * di un'altra, il segnaposto ha un id generato in locale che con la riga del
   * DB non c'entra niente, e cercarlo per id non troverebbe mai nulla.
   * Ritorna `true` se ha tolto qualcosa.
   */
  const dropEmptyTurn = useCallback((sessionKey: string, messageId?: string): boolean => {
    const msgs = messagesRef.current[sessionKey] || [];
    if (msgs.length === 0) return false;
    const byId = messageId ? msgs.findIndex(m => m.id === messageId) : -1;
    const target = byId >= 0 ? byId : msgs.length - 1;
    const victim = msgs[target];
    if (!isEmptyAssistantTurn(victim)) return false;
    const trimmed = [...msgs.slice(0, target), ...msgs.slice(target + 1)];
    // L'updater resta PURO e ricontrolla su `prev`: fra la lettura del ref e il
    // commit può essere arrivato un altro evento, e riscrivere `trimmed` alla
    // cieca cancellerebbe quello che è arrivato nel mezzo.
    setMessages(prev => {
      const cur = prev[sessionKey] || [];
      const at = cur.findIndex(m => m.id === victim.id);
      if (at < 0 || !isEmptyAssistantTurn(cur[at])) return prev;
      return { ...prev, [sessionKey]: [...cur.slice(0, at), ...cur.slice(at + 1)] };
    });
    cacheMessages(sessionKey, trimmed);
    return true;
  }, []);

  // Append a delta or tool call to the message's chronological `blocks`
  // timeline, coalescing consecutive same-kind text/thinking deltas. Returns
  // a NEW blocks array so React sees the change. This is the source of
  // truth for ordering — legacy `content`/`thinking`/`toolCalls` are still
  // populated alongside for components that haven't migrated yet.
  const appendBlock = (existing: ContentBlock[] | undefined, block: ContentBlock): ContentBlock[] => {
    const arr = existing ? existing.slice() : [];
    const last = arr[arr.length - 1];
    if (block.kind === 'text' && last?.kind === 'text') {
      arr[arr.length - 1] = { kind: 'text', text: last.text + block.text };
      return arr;
    }
    if (block.kind === 'thinking' && last?.kind === 'thinking') {
      arr[arr.length - 1] = { kind: 'thinking', text: last.text + block.text };
      return arr;
    }
    arr.push(block);
    return arr;
  };

  const appendToLastMessage = useCallback((sessionKey: string, contentDelta?: string, thinkingDelta?: string) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = liveAssistantIndex(sessionMessages, streamMessageIdRef.current.get(sessionKey));

      if (lastMessageIndex >= 0) {
        const updatedMessages = [...sessionMessages];
        const lastMsg = sessionMessages[lastMessageIndex];

        let nextBlocks = lastMsg.blocks;
        if (contentDelta) nextBlocks = appendBlock(nextBlocks, { kind: 'text', text: contentDelta });
        if (thinkingDelta) nextBlocks = appendBlock(nextBlocks, { kind: 'thinking', text: thinkingDelta });

        // Create a new object without mutating the old state reference
        updatedMessages[lastMessageIndex] = {
          ...lastMsg,
          content: contentDelta ? (lastMsg.content || '') + contentDelta : lastMsg.content,
          thinking: thinkingDelta ? (lastMsg.thinking || '') + thinkingDelta : lastMsg.thinking,
          blocks: nextBlocks,
        };

        return {
          ...prev,
          [sessionKey]: updatedMessages,
        };
      }

      return prev;
    });
  }, []);

  const addToolCallToLastMessage = useCallback((sessionKey: string, toolCall: ToolCall) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = liveAssistantIndex(sessionMessages, streamMessageIdRef.current.get(sessionKey));

      if (lastMessageIndex >= 0) {
        const updatedMessages = [...sessionMessages];
        const lastMsg = updatedMessages[lastMessageIndex];

        // Defensive dedup (mirror of server-side `addToolCallToLastMessage`).
        // Cumulative-snapshot providers (Claude CLI) re-announce the same
        // tool_use block multiple times; without this guard each
        // re-announcement appends a fresh duplicate entry, and only the
        // FIRST one ever flips to 'success' when stream:tool_result arrives —
        // the rest stay in `running` and the spinner never clears.
        const existingIdx = (lastMsg.toolCalls ?? []).findIndex(t => t.id === toolCall.id);
        let nextToolCalls: typeof lastMsg.toolCalls;
        let nextBlocks = lastMsg.blocks;
        if (existingIdx >= 0) {
          // Update in place — preserve any state the existing entry already
          // accumulated (e.g. result if a re-announce raced after the first
          // settle). The new payload's args usually win.
          nextToolCalls = lastMsg.toolCalls!.slice();
          nextToolCalls[existingIdx] = { ...lastMsg.toolCalls![existingIdx], ...toolCall };
          if (nextBlocks) {
            nextBlocks = nextBlocks.map(b =>
              b.kind === 'tool' && b.toolCall.id === toolCall.id
                ? { kind: 'tool' as const, toolCall: nextToolCalls![existingIdx] }
                : b,
            );
          }
        } else {
          nextToolCalls = lastMsg.toolCalls ? [...lastMsg.toolCalls, toolCall] : [toolCall];
          nextBlocks = appendBlock(lastMsg.blocks, { kind: 'tool', toolCall });
        }

        updatedMessages[lastMessageIndex] = { ...lastMsg, toolCalls: nextToolCalls, blocks: nextBlocks };

        return {
          ...prev,
          [sessionKey]: updatedMessages,
        };
      }

      return prev;
    });
  }, []);

  // Handle WebSocket stream events (cross-window sync)
  // ── Live-delta coalescing (CHAT-PERF-01) ───────────────────────────────────
  // Every streaming path delivers content/thinking one frame per token —
  // cross-window WS mirroring AND the foreground SSE readers alike. (The
  // comment here used to claim SSE "batches per read-cycle": measured against
  // the real server it does not, `reader.read()` returns one chunk per token on
  // loopback, so that batch is exactly 1.) Committing each token as its own
  // render makes the streaming bubble re-parse markdown per token (O(n²) over a
  // turn) and, since `messages` lives in App's state, re-renders from the root
  // 50-150 times a second. Buffer per session and flush at most once per
  // animation frame, so the cost is capped by the frame rate instead of by the
  // token rate. ALL THREE readers route through here. Any NON-delta event
  // flushes synchronously first, so the chronological `blocks` timeline stays
  // correctly ordered: a tool block must never jump ahead of text before it.
  const liveDeltaBufferRef = useRef<Map<string, { content: string; thinking: string }>>(new Map());
  const liveDeltaRafRef = useRef<number | null>(null);

  const flushLiveDeltas = useCallback((sessionKey?: string) => {
    const buf = liveDeltaBufferRef.current;
    const keys = sessionKey != null ? (buf.has(sessionKey) ? [sessionKey] : []) : [...buf.keys()];
    for (const k of keys) {
      const pending = buf.get(k);
      buf.delete(k);
      if (pending && (pending.content || pending.thinking)) {
        appendToLastMessage(k, pending.content || undefined, pending.thinking || undefined);
      }
    }
    if (buf.size === 0 && liveDeltaRafRef.current != null) {
      cancelAnimationFrame(liveDeltaRafRef.current);
      liveDeltaRafRef.current = null;
    }
  }, [appendToLastMessage]);

  const bufferLiveDelta = useCallback((sessionKey: string, contentDelta?: string, thinkingDelta?: string) => {
    const buf = liveDeltaBufferRef.current;
    const entry = buf.get(sessionKey) ?? { content: '', thinking: '' };
    if (contentDelta) entry.content += contentDelta;
    if (thinkingDelta) entry.thinking += thinkingDelta;
    buf.set(sessionKey, entry);
    if (liveDeltaRafRef.current == null) {
      liveDeltaRafRef.current = requestAnimationFrame(() => {
        liveDeltaRafRef.current = null;
        flushLiveDeltas();
      });
    }
  }, [flushLiveDeltas]);

  /**
   * Una patch a UNA riga di tool, pubblicata SOLO se ha cambiato qualcosa.
   *
   * I gestori scrivevano `{ ...prev, [sessionKey]: msgs }` in ogni caso, anche
   * quando la scansione all'indietro non trovava la riga: un oggetto di stato
   * nuovo, quindi una passata di render dell'intera chat, per zero modifiche. E
   * i frame che finiscono qui hanno il ritmo dell'OUTPUT del comando, non quello
   * dei token. `patchToolCallInMessages` restituisce l'array com'era quando non
   * trova niente: qui quel «com'era» diventa un `prev` che React salta.
   */
  const applyToolPatch = useCallback((sessionKey: string, toolCallId: string, patch: (tc: ToolCall) => ToolCall) => {
    setMessages(prev => {
      const cur = prev[sessionKey];
      if (!cur || cur.length === 0) return prev;
      const next = patchToolCallInMessages(cur, toolCallId, patch);
      return next === cur ? prev : { ...prev, [sessionKey]: next };
    });
  }, []);

  // ── Coalescing degli aggiornamenti di tool (CHAT-PERF-02) ─────────────────
  // `stream:tool_update` porta l'output di un comando ancora in corso, e ne
  // arriva uno per RIGA stampata: un `npm install` ne manda centinaia al
  // secondo. Il gestore lo applica SOSTITUENDO `result` — non appendendo — e
  // questo è ciò che rende il buffer senza perdite: applicare tutti i frame in
  // sequenza o solo l'ULTIMO di ciascun tool lascia esattamente lo stesso stato.
  // (Il lato server conferma la lettura: `providers/codex.ts` manda
  // `aggregated_output`, cioè il cumulato, e sul ramo `exec_command_output_delta`
  // accumula in `ctx.partial` prima di spedire. Ma la garanzia sta QUI, nella
  // forma della patch, non nella cortesia del provider.)
  const toolUpdateBufferRef = useRef<Map<string, Map<string, string>>>(new Map());
  const toolUpdateRafRef = useRef<number | null>(null);

  const flushToolUpdates = useCallback((sessionKey?: string) => {
    const buf = toolUpdateBufferRef.current;
    if (buf.size === 0) return;
    const keys = sessionKey != null ? (buf.has(sessionKey) ? [sessionKey] : []) : [...buf.keys()];
    if (keys.length === 0) return;
    const pending: Array<[string, Map<string, string>]> = [];
    for (const k of keys) {
      const perTool = buf.get(k);
      buf.delete(k);
      if (perTool && perTool.size > 0) pending.push([k, perTool]);
    }
    if (buf.size === 0 && toolUpdateRafRef.current != null) {
      cancelAnimationFrame(toolUpdateRafRef.current);
      toolUpdateRafRef.current = null;
    }
    if (pending.length === 0) return;
    setMessages(prev => {
      let next = prev;
      for (const [sk, perTool] of pending) {
        const cur = next[sk];
        if (!cur || cur.length === 0) continue;
        let msgs = cur;
        for (const [toolCallId, partialResult] of perTool) {
          msgs = patchToolCallInMessages(msgs, toolCallId, tc => ({ ...tc, result: partialResult }));
        }
        if (msgs !== cur) next = { ...next, [sk]: msgs };
      }
      return next;
    });
  }, []);

  const bufferToolUpdate = useCallback((sessionKey: string, toolCallId: string, partialResult: string) => {
    const buf = toolUpdateBufferRef.current;
    const perTool = buf.get(sessionKey) ?? new Map<string, string>();
    perTool.set(toolCallId, partialResult);
    buf.set(sessionKey, perTool);
    if (toolUpdateRafRef.current == null) {
      toolUpdateRafRef.current = requestAnimationFrame(() => {
        toolUpdateRafRef.current = null;
        flushToolUpdates();
      });
    }
  }, [flushToolUpdates]);

  // Drop any buffered deltas on unmount (server holds the authoritative copy;
  // this window re-syncs via loadHistory). No setState on a dead component.
  useEffect(() => () => {
    if (liveDeltaRafRef.current != null) cancelAnimationFrame(liveDeltaRafRef.current);
    liveDeltaBufferRef.current.clear();
    if (toolUpdateRafRef.current != null) cancelAnimationFrame(toolUpdateRafRef.current);
    toolUpdateBufferRef.current.clear();
  }, []);

  const handleStreamEvent = useCallback((event: WSMessage) => {
    // Every stream:* and message:media variant carries a sessionKey, but the
    // dispatcher upstream accepts the full WSMessage union (which includes
    // events that don't). Narrow via `in` so the rest of this function can
    // use `sessionKey` without per-case re-narrowing on each switch arm.
    const sessionKey = 'sessionKey' in event ? (event as { sessionKey?: string }).sessionKey : undefined;
    if (!sessionKey) return;

    // Ordering guarantee: a non-delta event must see buffered text already
    // committed before it reads/mutates the last message (blocks timeline).
    if (event.type !== 'stream:content_chunk' && event.type !== 'stream:thinking_chunk') {
      flushLiveDeltas(sessionKey);
    }
    // Stessa regola per gli output di tool bufferati: qualunque evento che NON
    // sia un altro `tool_update` deve vedere l'ultimo parziale già applicato. Il
    // caso che conta è `stream:tool_result`, che scrive l'esito definitivo sulla
    // stessa riga: se un parziale in coda atterrasse dopo, lo sovrascriverebbe
    // con del testo vecchio.
    if (event.type !== 'stream:tool_update') {
      flushToolUpdates(sessionKey);
    }

    // Skip WS stream events for sessions with an active local SSE stream
    // (sendMessage already processes these via HTTP response — avoid double content).
    //
    // `stream:usage` NON è fra i saltati, ed è il motivo per cui la finestra da
    // cui parte il turno vedeva i token fermi a zero.
    //
    // Questo cancello esiste contro il DOPPIONE: ciò che l'SSE della nostra
    // POST /api/chat già porta non va riprocessato dal filo. Il consumo però
    // sull'SSE non viaggia — il server lo emette SOLO come broadcast WS
    // (routes/chat.ts, `onUsage`) — e da quando i numeri vivono sulla riga del
    // messaggio invece che in uno stato dentro la striscia (676b9e28, «I numeri
    // del turno vivono sul messaggio»), passano di qui: prima
    // `TurnActivityIndicator` si iscriveva al filo per conto suo e questo
    // cancello non lo toccava. Risultato: la finestra che stai guardando —
    // quella che ha mandato il messaggio — era l'UNICA a non vedere crescere il
    // consumo, mentre le altre sì.
    //
    // Farlo passare non può duplicare niente: il server manda TOTALI già
    // accumulati e il gestore li SCRIVE (non li somma) sull'ultima riga, quindi
    // riceverlo due volte darebbe lo stesso numero. Gli eventi TERMINALI
    // restano scartati — processarli qui duplicherebbe la finalizzazione — ma
    // non li buttiamo del tutto: dicono che il server ha chiuso il turno, e se
    // il nostro SSE non chiude dietro sono l'unico modo per accorgersene. Vedi
    // scheduleSSEFailsafe.
    // `stream:tool_permission_required` passa per la STESSA ragione di
    // `stream:usage`, ed è il caso peggiore della stessa famiglia: il pannello
    // del permesso viaggia SOLO su WebSocket (`server/routes/topics.ts:2057`) e
    // sull'SSE non c'è. Scartandolo, la finestra che possiede l'SSE — cioè
    // proprio quella da cui hai mandato il messaggio — era strutturalmente
    // CIECA al pannello che stava aspettando: restava a girare, mentre il
    // telefono, che l'SSE non ce l'ha, lo mostrava. E un refresh «lo faceva
    // comparire» perché ricaricava dallo snapshot invece che dal filo.
    //
    // Non può duplicare niente, per lo stesso motivo dell'usage: il gestore
    // SCRIVE uno stato fisso sulla tool call (`awaiting_permission` + la
    // richiesta), non accumula — riceverlo due volte lascia lo stesso stato.
    const passaAncheAlMittente =
      event.type === 'stream:usage' || event.type === 'stream:tool_permission_required';
    if (localSSESessionsRef.current.has(sessionKey) && !passaAncheAlMittente) {
      if (event.type === 'stream:end' || event.type === 'stream:error') scheduleSSEFailsafe(sessionKey);
      return;
    }

    switch (event.type) {
      case 'stream:start':
        beginStreaming(sessionKey);
        resetStreamTimeout(sessionKey); // Start timeout watchdog
        // Il nome DUREVOLE della bolla in volo, tenuto per sessione finché il
        // turno non finisce. Serve a `addMessage`: un `message:new` che arriva a
        // turno aperto con un id DIVERSO da questo non è la fine del turno, è
        // un'altra riga (l'uscita di un sotto-agente), e non deve fondersi nel
        // segnaposto vivo. Vedi il ramo di fusione in `addMessage`.
        if (event.messageId) streamMessageIdRef.current.begin(sessionKey, event.messageId);
        // Le delta del turno di PRIMA non devono atterrare dopo l'azzeramento:
        // sono già dentro la bolla che stiamo per svuotare, e ricomparirebbero
        // in testa al replay.
        if (event.reattached) liveDeltaBufferRef.current.delete(sessionKey);
        // Only create assistant placeholder if there isn't already a partial one
        // (sendMessage creates one via SSE, so WS broadcast to OTHER windows only)
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          if (lastMsg?.role === 'assistant' && lastMsg.partial) {
            // Riadozione dopo un riavvio del server: la bolla c'è già ed è
            // PIENA di quello che il turno aveva scritto prima. Il replay sta
            // per ridettarlo tutto in delta, che qui si appendono: senza questo
            // azzeramento il turno uscirebbe doppio. Vedi streamReattachReset.ts.
            if (event.reattached) {
              const cleared = clearPartialForReattach(sessionMessages);
              return cleared === sessionMessages ? prev : { ...prev, [sessionKey]: cleared };
            }
            // Already have a partial assistant message — skip duplicate
            return prev;
          }
          // No partial assistant msg — this is from another window, create placeholder
          //
          // L'id è QUELLO DEL SERVER quando ce lo dice, e ce lo dice sempre
          // (`shared/ws-outbound.ts`: `messageId` è obbligatorio su
          // `stream:start`). Coniarne uno locale significava che la riga in DB e
          // la bolla a schermo avevano due nomi diversi: un `loadHistory` a metà
          // turno riportava indietro la stessa risposta sotto il nome vero, non
          // riconosceva il segnaposto e la disegnava DUE VOLTE.
          return {
            ...prev,
            [sessionKey]: [...sessionMessages, {
              // NIENTE RIPIEGO: `messageId` e' obbligatorio sul filo e non vuoto
              // (`shared/ws-outbound.ts`, `z.string().min(1)`), quindi un id
              // coniato qui sarebbe solo il ramo rotto preso in silenzio.
              id: event.messageId,
              role: 'assistant' as const,
              content: '',
              timestamp: new Date().toISOString(),
              partial: true,
            }],
          };
        });
        break;

      case 'stream:thinking_start':
        setThinking(prev => ({ ...prev, [sessionKey]: true }));
        break;

      case 'stream:thinking_chunk':
        if (event.content) {
          bufferLiveDelta(sessionKey, undefined, event.content);
        }
        break;

      case 'stream:thinking_end':
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        break;

      case 'stream:content_chunk':
        if (event.content) {
          const cleanedChunk = cleanInvisibleMarkers(event.content);
          if (cleanedChunk) bufferLiveDelta(sessionKey, cleanedChunk, undefined);
          resetStreamTimeout(sessionKey); // Reset watchdog on each chunk (immediate, not deferred)
        }
        break;

      case 'stream:compaction':
        // Context compaction boundary (CHAT-COMPACT-01) — display-only divider.
        // Render-only: no message mutation, no model resume.
        upsertMarker(sessionKey, {
          id: event.markerId,
          sessionKey,
          topicId: event.topicId ?? null,
          afterMessageId: event.afterMessageId ?? null,
          trigger: event.trigger,
          ...(typeof event.preTokens === 'number' ? { preTokens: event.preTokens } : {}),
          ...(typeof event.postTokens === 'number' ? { postTokens: event.postTokens } : {}),
          createdAt: event.createdAt,
        });
        break;

      case 'stream:tool_call':
        if (event.toolCall) {
          addToolCallToLastMessage(sessionKey, event.toolCall as ToolCall);
        }
        break;

      case 'stream:tool_result':
        // Replace the ToolCall with a new instance so React.memo on
        // MessageContent sees a real prop change. `patchToolCallInMessages`
        // mirrors it into both the legacy `toolCalls` bucket and the
        // chronological `blocks` timeline — e restituisce l'array com'era se la
        // riga non c'è, così un id sconosciuto non ridisegna la chat.
        if (event.toolCallId) {
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({
            ...oldTc,
            status: ((event.status as ToolCall['status']) || 'success'),
            result: event.result as string | undefined,
            error: (event.error as string | undefined) ?? oldTc.error,
            detail: (event.detail as ToolCall['detail']) ?? oldTc.detail,
            // Server stamps the real-usage close on the result event;
            // durations render from endedAt - startedAt.
            endedAt: (typeof event.endedAt === 'number' ? event.endedAt : undefined) ?? oldTc.endedAt,
          }));
        }
        break;

      case 'stream:tool_usage':
        // Costo/token di UNA azione, attribuiti dalla chiamata che l'ha decisa
        // (server onToolUsage). Patcha la riga del tool per id, come
        // stream:tool_result — nuova istanza ToolCall così React.memo vede il
        // cambio. Arriva mentre il tool è ancora running: non tocca status.
        if (event.toolCallId) {
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({
            ...oldTc,
            ...(typeof event.tokens === 'number' ? { tokens: event.tokens } : {}),
            ...(typeof event.costCents === 'number' ? { costCents: event.costCents } : {}),
          }));
        }
        break;

      case 'stream:tool_update':
        // Live partial result from a long-running tool (e.g. a Bash that
        // streams output). Server's openclaw provider emits these via
        // gateway-ws; claude-code currently doesn't (it only sees cumulative
        // assistant snapshots). Patch the running tool's `result` field with
        // the partial so the user sees output flowing in instead of staring
        // at a spinner. Status stays 'running' — the terminal status comes
        // later via stream:tool_result.
        //
        // Passa dal buffer a frame: ne arriva uno per riga stampata, e la patch
        // SOSTITUISCE `result`, quindi tenere solo l'ultimo del frame lascia lo
        // stesso stato. Vedi `bufferToolUpdate`.
        if (event.toolCallId && typeof event.partialResult === 'string') {
          bufferToolUpdate(sessionKey, event.toolCallId, event.partialResult);
        }
        break;

      case 'stream:tool_detail':
        // Sub-agent (Task) snapshot update from the server's SidechainTracker.
        // Patches the parent Task tool's `detail` field with the latest
        // actions[] log so the renderer's <SubAgentCard> can show live progress.
        // Snapshot, not delta — replace the whole detail.
        if (event.toolCallId && event.detail) {
          const detail = event.detail as ToolCall['detail'];
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({ ...oldTc, detail }));
        }
        break;

      case 'stream:tool_permission_resolved':
        // Qualcuno ha deciso — magari su un altro dispositivo. La riga torna a
        // girare e l'esito RESTA visibile: senza questo evento il pannello
        // spariva e della decisione non restava traccia fino al reload,
        // perché `stream:tool_update` porta solo `partialResult`.
        if (event.toolCallId) {
          const outcome = event.outcome;
          applyToolPatch(sessionKey, event.toolCallId, (tc) => ({
            ...tc,
            status: 'running',
            permissionOutcome: outcome,
          }));
        }
        break;

      case 'stream:tool_permission_required':
        // La CLI chiede se questo strumento può partire. Stesso trattamento del
        // pannello delle domande per ciò che riguarda il turno (resta in volo,
        // lo Stop resta disponibile), stato diverso per ciò che riguarda la
        // riga: `awaiting_permission` + una richiesta tipizzata.
        if (event.toolCallId) {
          resetStreamTimeout(sessionKey);
          const request = event.request;
          applyToolPatch(sessionKey, event.toolCallId, (tc) => ({
            ...tc,
            status: 'awaiting_permission',
            permissionRequest: request,
            permissionOutcome: undefined,
          }));
        }
        break;

      case 'stream:tool_user_input_required':
        // The provider paused the stream waiting for a human answer.
        // Patch the matching ToolCall on the last assistant message so
        // <ToolCallRow> can swap its spinner for <ToolInputForm>. We
        // intentionally do NOT clear the streaming flag — the turn is
        // still in flight; the composer's unified Stop button must stay
        // available as an escape hatch (see composerAction.ts). The
        // soft-timeout watchdog is reset because we just heard from the
        // provider, but it won't fire as long as a tool is open.
        if (event.toolCallId) {
          resetStreamTimeout(sessionKey);
          const schema = event.schema;
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({
            ...oldTc,
            status: 'waiting_for_input',
            userInputSchema: schema,
          }));
        }
        break;

      // I numeri del turno MENTRE cresce — token, scorporo della cache, costo.
      //
      // Vivevano dentro `TurnActivityIndicator`, che si iscriveva al filo per
      // conto suo e li teneva in uno stato locale. Il frame passa UNA volta e
      // nessuno lo conserva: chi montava dopo — una pane aperta a turno già in
      // corso, un cambio di tab, qualunque remount della riga — non li vedeva
      // comparire mai più, e in chat restava un turno che macina senza dire
      // quanto sta costando. Qui finiscono sul MESSAGGIO, che è lo stato che
      // sopravvive ai remount: da lì li legge la striscia viva e, a turno
      // fermo su una domanda, la stessa striscia di chiusura di un messaggio
      // finito. Il server manda i TOTALI già accumulati: qui non si somma.
      case 'stream:usage': {
        const u = event as unknown as {
          promptTokens?: number; completionTokens?: number; costCents?: number;
          cacheReadTokens?: number; cacheCreationTokens?: number; cacheCreation1hTokens?: number;
          model?: string;
        };
        // Ogni campo si scrive SOLO se c'è davvero.
        //
        // Scriverli tutti significava che un frame senza uno di quei numeri —
        // il provider non li manda sempre tutti — lo azzerava a `undefined`, e
        // la striscia di fine turno spariva: `MessageMetaFooter` non disegna
        // niente quando non ha né durata né token né costo. Un aggiornamento
        // non deve poter CANCELLARE quello che sapevamo già.
        const patch: Partial<ChatMessage> = {};
        if (u.promptTokens != null) patch.usagePromptTokens = u.promptTokens;
        if (u.completionTokens != null) patch.usageCompletionTokens = u.completionTokens;
        if (u.costCents != null) patch.costCents = u.costCents;
        if (u.cacheReadTokens != null) patch.cacheReadTokens = u.cacheReadTokens;
        if (u.cacheCreationTokens != null) patch.cacheCreationTokens = u.cacheCreationTokens;
        if (u.cacheCreation1hTokens != null) patch.cacheCreation1hTokens = u.cacheCreation1hTokens;
        if (u.model) patch.model = u.model;
        if (Object.keys(patch).length > 0) updateLastMessage(sessionKey, patch);
        break;
      }

      case 'stream:error':
        clearStreamTimeout(sessionKey);
        streamMessageIdRef.current.end(sessionKey);
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        if (event.error) {
          updateLastMessage(sessionKey, { partial: false });
        }
        break;

      case 'stream:end':
        clearStreamTimeout(sessionKey); // Clear watchdog
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        // Clear any stale "queued" error banner on successful stream completion
        setError(prev => (prev?.includes('queued') ? null : prev));
        // Il turno è stato fermato prima che il modello producesse qualcosa: il
        // server ha CANCELLATO la riga, non finalizzata. Toglierla anche qui, o
        // questa finestra resta con una bolla vuota che il DB non ha più (e che
        // sparirebbe solo al reload).
        if (event.discardedMessageId) dropEmptyTurn(sessionKey, event.discardedMessageId);
        // Strip any remaining browser markers (handles split-across-chunks case)
        //
        // La scrittura in cache sta FUORI dall'updater. Un updater di `setState`
        // deve essere puro: React lo esegue due volte in StrictMode e puo'
        // rieseguirlo quando gli pare. Dentro c'era una `cacheMessages`, cioe'
        // una serializzazione dell'intera conversazione piu' una scrittura su
        // localStorage — che a quota piena scandisce anche tutte le altre voci
        // per fare spazio. Il pattern "mitigazione dentro il percorso caldo" e'
        // esattamente quello che oggi, sul tetto delle pane, ha fatto crescere
        // la memoria dodici volte.
        {
        const cacheOnEnd: { msgs: ChatMessage[] | null } = { msgs: null };
        setMessages(prev => {
          const msgs = prev[sessionKey] || [];
          // La bolla del TURNO, non «l'ultima»: a turno con sotto-agenti in coda
          // può esserci il rapporto di uno di loro. Vedi `liveAssistantIndex`.
          const at = liveAssistantIndex(msgs, streamMessageIdRef.current.get(sessionKey));
          const last = at >= 0 ? msgs[at] : undefined;
          if (last) {
            // Always run through the centralized cleaner so detection tracks the
            // full marker set; only rewrite if it actually changed something.
            const cleaned = cleanInvisibleMarkers(last.content);
            if (cleaned !== last.content) {
              const updated = [...msgs];
              updated[at] = { ...last, content: cleaned, partial: false };
              cacheOnEnd.msgs = updated;
              return { ...prev, [sessionKey]: updated };
            }
          }
          cacheOnEnd.msgs = msgs;
          return prev;
        });
        // Cache after stream finishes
        if (cacheOnEnd.msgs) cacheMessages(sessionKey, cacheOnEnd.msgs);
        }
        {
          // Persist latency / token usage / cost from the stream:end payload
          // onto the last message so the footer can render them. All four
          // fields are optional on `WSStreamEndMessage` — only patch the
          // ones the server actually included on this turn.
          const finalPatch: Partial<ChatMessage> = { partial: false };
          if (typeof event.latencyMs === 'number') finalPatch.latencyMs = event.latencyMs;
          if (typeof event.usagePromptTokens === 'number') finalPatch.usagePromptTokens = event.usagePromptTokens;
          if (typeof event.usageCompletionTokens === 'number') finalPatch.usageCompletionTokens = event.usageCompletionTokens;
          if (typeof event.costCents === 'number') finalPatch.costCents = event.costCents;
          if (typeof event.model === 'string' && event.model) finalPatch.model = event.model;
          // Lo scorporo della cache, sullo stesso principio degli altri: si applica
          // SOLO se il server l'ha mandato. Un `?? 0` qui scriverebbe "misurato,
          // nessuna cache" su un turno di cui non sappiamo la composizione.
          if (typeof event.cacheReadTokens === 'number') finalPatch.cacheReadTokens = event.cacheReadTokens;
          if (typeof event.cacheCreationTokens === 'number') finalPatch.cacheCreationTokens = event.cacheCreationTokens;
          if (typeof event.cacheCreation1hTokens === 'number') finalPatch.cacheCreation1hTokens = event.cacheCreation1hTokens;
          updateLastMessage(sessionKey, finalPatch);
        }
        // Il turno è finito: se c'è una coda, tocca a lei — a meno che il turno
        // sia finito perché QUALCUNO L'HA FERMATO. Lo `stream:end` di un abort
        // è indistinguibile da quello di un turno arrivato in fondo, ed è
        // esattamente per questo che il freno è una bandiera a sé
        // (`holdQueue`): senza, premere «ferma» faceva PARTIRE il messaggio in
        // coda. Vedi `state/chatQueue.ts`.
        // Il nome della riga in volo si dimentica QUI, non in cima al caso: la
        // finalizzazione qui sopra (`partial:false`, durata, token, costo) deve
        // ancora trovare la bolla giusta, e senza il nome ricadrebbe sull'ultimo
        // messaggio — che a turno con sotto-agenti non è più lui.
        streamMessageIdRef.current.end(sessionKey);
        drainTurnQueueRef.current?.(sessionKey);
        break;

      case 'stream:catchup':
        // Full buffer catch-up from server on WS connect — set streaming
        // state and create/update the assistant message with accumulated
        // state. The merge logic (which carries toolCalls + blocks from
        // the DB partial row through to the client) lives in
        // `streamCatchupMerge.ts` so it can be unit-tested without React.
        beginStreaming(sessionKey);
        resetStreamTimeout(sessionKey);
        // Chi si attacca a turno già iniziato non ha visto `stream:start`: il
        // nome della riga in volo glielo dice il catchup, ed è lo stesso.
        if (event.messageId) streamMessageIdRef.current.begin(sessionKey, event.messageId);
        if (event.isThinking) {
          setThinking(prev => ({ ...prev, [sessionKey]: true }));
        }
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          const merged = mergeCatchupIntoPartial(
            {
              messageId: event.messageId,
              content: event.content,
              thinking: event.thinking,
              toolCalls: event.toolCalls,
              blocks: event.blocks,
            },
            lastMsg,
            generateMessageId,
            new Date().toISOString(),
          );
          if (lastMsg?.role === 'assistant' && lastMsg.partial) {
            const updated = [...sessionMessages];
            updated[updated.length - 1] = merged;
            return { ...prev, [sessionKey]: updated };
          }
          return { ...prev, [sessionKey]: [...sessionMessages, merged] };
        });
        break;

      case 'message:media':
        if (event.media?.length > 0) {
          updateLastMessage(sessionKey, {
            media: event.media,
          });
        }
        break;
    }
  }, [addToolCallToLastMessage, updateLastMessage, dropEmptyTurn, resetStreamTimeout, clearStreamTimeout, scheduleSSEFailsafe, bufferLiveDelta, flushLiveDeltas, bufferToolUpdate, flushToolUpdates, applyToolPatch, upsertMarker, beginStreaming]);

  // Register WebSocket handler
  const registerWSHandler = useCallback((handler: (event: WSMessage) => void) => {
    wsHandlersRef.current.add(handler);
    return () => wsHandlersRef.current.delete(handler);
  }, []);

  // Expose handler for App to connect
  const onWSMessage = useCallback((event: WSMessage) => {
    // Handle gateway connection status
    if (event.type === 'gateway:status') {
      setGatewayConnected(!!event.connected);
    }
    // Handle stream events directly
    if (event.type?.startsWith('stream:') || event.type === 'message:media') {
      handleStreamEvent(event);
    }
    // Il nome durevole del messaggio che questa finestra ha appena mandato.
    //
    // Il gestore dei pannelli scarta questo frame quando lo stream è nostro (la
    // bolla è già a schermo, e riaggiungerla sarebbe il doppione che si vuole
    // evitare), ma insieme al frame buttava via l'unica occasione di sapere
    // sotto quale id il server ha scritto quella riga. Da qui in poi la copia
    // ottimistica porta l'id del DB, e il ricarico della storia la riconosce
    // per identità invece che per testo. Non aggiunge MAI niente: se non trova
    // un segnaposto da ribattezzare, non tocca la lista.
    if (event.type === 'message:new' && event.role === 'user' && event.messageId) {
      const durevole = { role: 'user' as const, content: event.content ?? '', id: event.messageId };
      const sk = event.sessionKey;
      if (sk) {
        setMessages(prev => {
          const correnti = prev[sk];
          if (!correnti || correnti.length === 0) return prev;
          const next = adoptDurableMessageId(correnti, durevole);
          return next === correnti ? prev : { ...prev, [sk]: next };
        });
      }
    }
    // Forward to registered handlers
    for (const handler of wsHandlersRef.current) {
      try { handler(event); } catch {}
    }
  }, [handleStreamEvent]);

  /**
   * L'invio vero e proprio: apre la SSE, disegna le bolle, tiene il lock.
   *
   * NON decide più se spedire o accodare — quella decisione sta tutta in
   * `sendMessage` qui sotto, che è l'unico ingresso pubblico. Qui resta solo
   * l'ultima rete di sicurezza: se il lock è occupato (una corsa fra due
   * chiamate nello stesso istante) il messaggio va in coda invece di sparire.
   * Prima disegnava anche una bolla utente ottimista per un messaggio che non
   * era mai partito: al reload la bolla restava e il testo no.
   */
  /**
   * `restoreOnFailure`: chi chiama tenendo in mano l'UNICA copia del messaggio
   * (i due drain, che l'hanno estratto dalla coda durevole con `claimHead`)
   * passa qui il modo di rimetterla a posto. Serve perché `performSend` non
   * rigetta mai — cattura tutto e torna `true`/`false` — quindi un `catch` dal
   * lato del chiamante non scatterebbe: la testa era già stata tolta dallo
   * storage e un errore diverso da 409/rete la faceva sparire e basta. Viene
   * chiamato SOLO quando il server non ha visto il messaggio: se lo stream era
   * partito, rimetterlo in coda vorrebbe dire spedirlo due volte.
   */
  const performSend = useCallback(async (sessionKey: string, content: string, options?: SendMessageOptions, restoreOnFailure?: () => void): Promise<boolean> => {
    if (isSendLocked(sessionKey)) {
      enqueueTurn(sessionKey, content, options);
      return true;
    }
    acquireSendLock(sessionKey);
    // Un turno che PARTE toglie il freno dello stop, sempre e da qualunque
    // strada arrivi. Senza questa riga il freno alzato da uno stop resterebbe su
    // per sempre, e una coda riempita più tardi non ripartirebbe mai da sola.
    releaseHold(sessionKey);

    /**
     * La chiave di QUESTO messaggio, coniata una volta sola e riusata a ogni
     * tentativo. Arriva già fatta quando il messaggio viene dalla coda durevole
     * (è l'`id` dell'item, che il drain rimanda identico); si conia qui al primo
     * invio diretto. Deve nascere PRIMA della `fetch`, perché se quella cade il
     * ramo di riaccodamento più sotto deve poter salvare la STESSA chiave — è
     * tutto il punto: rispedire con la chiave di prima è sicuro, rispedire con
     * una nuova è un doppione.
     */
    const idemKey = options?.clientMessageId ?? crypto.randomUUID();

    let streamStarted = false; // Track if server received the request (don't re-queue if true)
    localSSESessionsRef.current.add(sessionKey); // Block WS duplicates for this session
    // Difesa in profondità: da qui parte un turno NUOVO, e il segnaposto lo conia
    // questa funzione con un id locale. Qualunque nome fosse rimasto appeso da un
    // turno precedente morto male è ormai il nome di una bolla morta, e le delta
    // di questo turno ci finirebbero dentro invece che nel segnaposto qui sotto.
    streamMessageIdRef.current.end(sessionKey);

    // Create AbortController for this session
    const abortController = new AbortController();
    abortControllersRef.current[sessionKey] = abortController;

    try {
      setError(null);
      setLoading(prev => ({ ...prev, [sessionKey]: true }));

      addMessage(sessionKey, {
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });

      // La coda, non tutto. Il ramo legato a una topic legge solo l'ultimo
      // elemento; quello senza topic usa `slice(0, -1)` come storia. Vedi
      // `chatRequestPayload.ts` per il perché di ciascuna delle due regole.
      const sessionMessages = messagesRef.current[sessionKey] || [];
      const apiMessages: Message[] = buildRequestMessages(sessionMessages, content);

      beginStreaming(sessionKey);

      // Create placeholder assistant message immediately for inline loading
      addMessage(sessionKey, {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        partial: true,
      });

      const chatRequest: ChatRequest = { sessionKey, messages: apiMessages, clientMessageId: idemKey };
      if (options?.fastMode) chatRequest.fastMode = true;
      if (options?.provider) chatRequest.provider = options.provider;
      if (options?.model) chatRequest.model = options.model;

      const stream = await chatApi.sendMessage(chatRequest, abortController.signal);

      if (!stream) {
        throw new Error('No stream received');
      }

      // Server received the request — do NOT re-queue on stream read errors
      streamStarted = true;

      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = stream.getReader();
      } catch (e) {
        await stream.cancel();
        throw e;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantMessageCreated = true;
      let currentContent = '';
      let isInThinking = false;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          // Batch content/thinking deltas per read-cycle to reduce React re-renders
          let contentBatch = '';
          let thinkingBatch = '';
          let isDone = false;

          // Ordering guarantee — the same contract handleStreamEvent honours at
          // :512-516. Anything that touches the `blocks` timeline (a tool call, a
          // tool result, the final `partial:false`) must see the text that came
          // BEFORE it already committed, or the tool row jumps ahead of the
          // sentence that introduces it. Two levels of pending text exist:
          // `contentBatch`/`thinkingBatch` for this read-cycle, and the rAF buffer
          // spanning cycles. Drain them in that order.
          const commitTextBefore = (): void => {
            if (contentBatch || thinkingBatch) {
              bufferLiveDelta(sessionKey, contentBatch || undefined, thinkingBatch || undefined);
              contentBatch = '';
              thinkingBatch = '';
            }
            flushLiveDeltas(sessionKey);
          };

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              isDone = true;
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.content) {
                let chunk = delta.content;

                // Detect thinking markers
                if (chunk.includes('<thinking>')) {
                  isInThinking = true;
                  setThinking(prev => ({ ...prev, [sessionKey]: true }));
                  chunk = chunk.replace('<thinking>', '');
                }
                if (chunk.includes('</thinking>')) {
                  isInThinking = false;
                  setThinking(prev => ({ ...prev, [sessionKey]: false }));
                  chunk = chunk.replace('</thinking>', '');
                }

                // Strip every internal marker family from visible content
                if (!isInThinking) chunk = cleanInvisibleMarkers(chunk);

                // Create assistant message on first content chunk
                if (!assistantMessageCreated) {
                  if (isInThinking) {
                    addMessage(sessionKey, {
                      role: 'assistant',
                      content: '',
                      thinking: chunk,
                      timestamp: new Date().toISOString(),
                      partial: true,
                    });
                  } else if (chunk) {
                    currentContent = chunk;
                    addMessage(sessionKey, {
                      role: 'assistant',
                      content: chunk,
                      timestamp: new Date().toISOString(),
                      partial: true,
                    });
                  }
                  if (chunk) assistantMessageCreated = true;
                } else {
                  // Accumulate into batch — single state update after the loop
                  if (isInThinking) {
                    thinkingBatch += chunk;
                  } else if (chunk) {
                    currentContent += chunk;
                    contentBatch += chunk;
                  }
                }
              }

              // Handle tool calls
              if (delta?.tool_calls) {
                commitTextBefore();
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    const toolCall: ToolCall = {
                      id: tc.id || generateMessageId(),
                      name: tc.function.name,
                      args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
                      status: 'running',
                      contentOffset: tc.contentOffset,
                    };
                    addToolCallToLastMessage(sessionKey, toolCall);
                  }
                }
              }

              // Handle tool results — update BOTH the legacy `toolCalls`
              // bucket and the new `blocks` timeline. Replace the ToolCall
              // object with a new instance (not just mutate in place) so
              // React.memo on MessageContent sees a real prop change and
              // re-renders the row out of its "running" state.
              if (delta?.tool_result) {
                const { id: trId, status: trStatus, result: trResult } = delta.tool_result;
                if (trId) {
                  commitTextBefore();
                  setMessages(prev => {
                    const msgs = [...(prev[sessionKey] || [])];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                        const tcIdx = msgs[i].toolCalls!.findIndex(t => t.id === trId);
                        if (tcIdx >= 0) {
                          const oldTc = msgs[i].toolCalls![tcIdx];
                          const newTc: ToolCall = { ...oldTc, status: trStatus || 'success', result: trResult };
                          const nextToolCalls = msgs[i].toolCalls!.slice();
                          nextToolCalls[tcIdx] = newTc;
                          let nextBlocks = msgs[i].blocks;
                          if (nextBlocks) {
                            nextBlocks = nextBlocks.map(b =>
                              b.kind === 'tool' && b.toolCall.id === trId
                                ? { kind: 'tool' as const, toolCall: newTc }
                                : b,
                            );
                          }
                          msgs[i] = { ...msgs[i], toolCalls: nextToolCalls, blocks: nextBlocks };
                          break;
                        }
                      }
                    }
                    return { ...prev, [sessionKey]: msgs };
                  });
                }
              }
            } catch (parseErr) {
              console.warn('Failed to parse SSE data:', parseErr);
            }
          }

          // Hand this read-cycle's deltas to the rAF coalescer instead of
          // committing them straight away. The comment above used to claim this
          // path "batches per read-cycle" — measured against the real server it
          // does not: writeSSE emits one frame per delta and `reader.read()`
          // returns one chunk per token, so the batch is exactly 1 and this was a
          // setMessages PER TOKEN, from the ROOT (messages lives in App's state).
          // Chromium throttles itself under that load; WebKit — the engine the
          // Tauri shell actually runs — does not: 300 tokens produced 300 React
          // commits, ~115/s at 150 tok/s. Coalescing caps it at the frame rate and,
          // more importantly, makes the cost self-limiting instead of unbounded.
          if (contentBatch || thinkingBatch) {
            bufferLiveDelta(sessionKey, contentBatch || undefined, thinkingBatch || undefined);
          }

          // Finalize after flushing so content is up to date
          if (isDone && assistantMessageCreated) {
            flushLiveDeltas(sessionKey); // `partial:false` must not race the last token
            if (currentContent.includes('{{BROWSER:') || currentContent.includes('{{TOPIC_SWITCH:') || currentContent.includes('{{TOPIC_NEW:') || currentContent.includes('{{PROJECT_')) {
              currentContent = cleanInvisibleMarkers(currentContent);
              updateLastMessage(sessionKey, { content: currentContent, partial: false });
            } else {
              updateLastMessage(sessionKey, { partial: false });
            }
          }
        }
      } finally {
        // An aborted or failed stream must not leave the last tokens stranded in
        // the buffer: commit whatever arrived, then let the history reload below
        // reconcile against the server's authoritative copy.
        flushLiveDeltas(sessionKey);
        reader.releaseLock();
      }

      // Reload full history to sync server-generated IDs and branching metadata
      try {
        const historyResponse = await chatApi.getHistory(sessionKey, { limit: HISTORY_FETCH_ALL });
        const chatMessages: ChatMessage[] = historyResponse.messages
          .filter(msg => !isContextMessage(msg.content))
          .map(msg => ({
            ...msg,
            id: msg.id || generateMessageId(),
            content: cleanInvisibleMarkers(msg.content || ''),
            timestamp: msg.timestamp || new Date().toISOString(),
          }));
        setMessages(prev => ({ ...prev, [sessionKey]: chatMessages }));
        hydratedSessionsRef.current.add(sessionKey);
      } catch {}

      // Turno concluso in casa (SSE locale): stessa regola dello `stream:end`
      // via WS — tocca alla coda, se non è stata messa in freno da uno stop.
      drainTurnQueueRef.current?.(sessionKey);

      return true;
    } catch (err) {
      // User-initiated abort — just finalize, no error
      if (err instanceof DOMException && err.name === 'AbortError') {
        updateLastMessage(sessionKey, { partial: false });
        return true;
      }

      console.error('Failed to send message:', err);

      // 409 = stream already active for this session — queue the message for auto-send
      // when the current stream ends (Claude Code-style message queuing)
      const is409 = !!err && typeof err === 'object' && 'status' in err && (err as { status?: unknown }).status === 409;

      /**
       * DUE 409 CHE VOGLIONO L'OPPOSTO.
       *
       * `stream_in_flight` dice «c'è già un turno in volo»: il messaggio non è
       * arrivato e va rimesso in testa alla coda per partire dopo.
       * `duplicate_message` dice il contrario — il server questo messaggio ce
       * l'ha GIÀ, è la nostra stessa chiave di prima. Riaccodarlo lo farebbe
       * spedire una seconda volta, cioè esattamente il doppione che la chiave
       * serve a evitare. Qui si smette: le bolle ottimiste vanno via e la
       * history si ricarica, perché la verità di questo messaggio ora sta sul
       * server e non più in pagina.
       */
      const duplicate = is409 && err instanceof Error && err.message.includes('duplicate_message');
      if (duplicate) {
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          let end = sessionMessages.length;
          const last = sessionMessages[end - 1];
          if (last?.role === 'assistant' && last.partial && !last.content) end -= 1;
          const lastUser = sessionMessages[end - 1];
          if (lastUser?.role === 'user' && lastUser.content === content) end -= 1;
          return end === sessionMessages.length ? prev : { ...prev, [sessionKey]: sessionMessages.slice(0, end) };
        });
        void loadHistoryRef.current?.(sessionKey);
        return true;
      }

      if (is409) {
        // «C'è già un turno in volo»: il messaggio torna IN TESTA alla coda —
        // non in fondo, o si farebbe scavalcare da chi era dietro di lui.
        // Spariscono ANCHE le due bolle ottimiste: il segnaposto
        // dell'assistente e la domanda dell'utente. Prima la domanda restava in
        // pagina come se fosse partita, mentre il testo viveva in un ref
        // invisibile che un reload buttava via — si vedeva un messaggio spedito
        // che non era mai esistito. Adesso l'unico posto in cui vive è la coda,
        // e la coda si vede nel badge del composer.
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          let end = sessionMessages.length;
          const last = sessionMessages[end - 1];
          if (last?.role === 'assistant' && last.partial && !last.content) end -= 1;
          const lastUser = sessionMessages[end - 1];
          if (lastUser?.role === 'user' && lastUser.content === content) end -= 1;
          return end === sessionMessages.length ? prev : { ...prev, [sessionKey]: sessionMessages.slice(0, end) };
        });
        unshiftTurn(sessionKey, content, options);
        return true; // Return true since we accepted the message
      }

      // Only queue if the server never received the request (fetch itself failed).
      // If streamStarted=true, the server already has the message — do NOT re-queue.
      const isNetworkError = err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'));
      if (isNetworkError && !streamStarted) {
        // L'id dell'item in coda È la chiave di idempotenza del tentativo appena
        // fallito, non una nuova. Coniarne una fresca qui rendeva il rinvio un
        // messaggio diverso agli occhi del server: se il tentativo di prima era
        // arrivato — e da qui non si può sapere — il rinvio lo duplicava.
        const queued: QueuedMessage = { sessionKey, content, timestamp: new Date().toISOString(), options, id: idemKey };
        setPendingQueue(enqueue(queueStorage, OUTBOUND_QUEUE_KEY, queued));
        // Mark the user message as queued (keep it visible)
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          if (lastMsg?.role === 'user') {
            const updated = [...sessionMessages];
            updated[updated.length - 1] = { ...lastMsg, partial: true, queued: true };
            return { ...prev, [sessionKey]: updated };
          }
          return prev;
        });
        setError('Message queued. It will send when reconnected.');
        return false;
      }

      // Errore che non è né un 409 né una rete caduta prima di partire. Se il
      // messaggio veniva dalla coda, questo è l'ULTIMO punto in cui esiste
      // ancora: `claimHead` l'ha tolto dallo storage durevole e nessuno dei
      // rami sopra l'ha raccolto. Senza questo, l'utente vede sparire una cosa
      // che aveva scritto — è la promessa fatta nel commento di `claimHead`.
      // Solo a stream mai partito: se era partito, il server ce l'ha già.
      if (!streamStarted) restoreOnFailure?.();

      setError(err instanceof Error ? err.message : 'Failed to send message');

      // Only remove last message if it's an empty assistant message (partial response)
      setMessages(prev => {
        const sessionMessages = prev[sessionKey] || [];
        const lastMsg = sessionMessages[sessionMessages.length - 1];
        // Remove if last message is assistant with empty or very short content (likely partial)
        if (lastMsg?.role === 'assistant' && lastMsg.content.length < 10 && !lastMsg.thinking) {
          return {
            ...prev,
            [sessionKey]: sessionMessages.slice(0, -1),
          };
        }
        return prev;
      });

      return false;
    } finally {
      releaseSendLock(sessionKey); // Release send lock
      clearSSEFailsafe(sessionKey); // lo stream è chiuso: niente abort in ritardo
      localSSESessionsRef.current.delete(sessionKey); // Re-enable WS events for this session
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
    }
  }, [addMessage, addToolCallToLastMessage, updateLastMessage, bufferLiveDelta, flushLiveDeltas, clearSSEFailsafe, beginStreaming]);

  /**
   * Fa partire quello che è in coda, se è il momento — TUTTO INSIEME, in un
   * turno solo. Chi ha scritto tre righe mentre l'agente lavorava non voleva
   * tre turni in fila: voleva che l'agente le leggesse tutte prima di partire
   * (`claimBatch`/`mergeBatch` in `state/chatQueue.ts`).
   *
   * È l'UNICO drenaggio della coda del turno. Prima ce n'erano tre — un effetto
   * dentro `ChatPane` (che quindi funzionava solo a pane montata, e scattava al
   * mount), il ramo `stream:end` e la fine della SSE locale — e nessuno dei tre
   * sapeva perché il turno fosse finito. Le tre condizioni che qui sono
   * esplicite:
   *
   *   1. **freno**: se l'umano ha premuto «ferma», non riparte niente. La coda
   *      resta visibile nel badge e la decide lui;
   *   2. **occupato**: se un altro turno è in volo si riprova poco dopo, senza
   *      mai perdere l'item (che resta scritto su disco finché non è preso);
   *   3. **prenotazione**: la testa esce una volta sola anche con due finestre
   *      aperte sullo stesso topic.
   */
  const drainTurnQueue = useCallback((sessionKey: string, attempt = 0): void => {
    if (isQueueHeld(sessionKey)) return;
    if (getTurnQueue(sessionKey).length === 0) return;
    if (isSendLocked(sessionKey) || streamingRef.current[sessionKey]) {
      if (attempt >= TURN_DRAIN_MAX_ATTEMPTS) return;
      setTimeout(() => drainTurnQueueRef.current?.(sessionKey, attempt + 1), TURN_DRAIN_RETRY_MS);
      return;
    }
    const batch = claimQueuedTurns(sessionKey, CLAIM_CLIENT_ID);
    if (batch.length === 0) return;
    const turn = mergeBatch(batch);
    void performSend(sessionKey, turn.content, turn.options, () => requeueFront(sessionKey, batch))
      .finally(() => releaseClaim(sessionKey, CLAIM_CLIENT_ID));
  }, [performSend, streamingRef]); // `streamingRef` e' uno specchio (useRefMirror): stesso oggetto a ogni render, quindi elencarlo non ridichiara nulla — serve solo a non lasciare un avviso exhaustive-deps che coprirebbe quelli veri.
  // In un effetto, non in fase di render, come il gemello `sendMessageRef` qui
  // sotto: scrivere un ref durante il render lo fa puntare alla closure di un
  // render che potrebbe non essere mai committato (StrictMode ne fa due, e uno
  // concorrente si può buttare via).
  useEffect(() => { drainTurnQueueRef.current = drainTurnQueue; }, [drainTurnQueue]);

  /**
   * L'ingresso pubblico: qui si decide fra spedire e accodare, e in nessun
   * altro posto (`state/chatQueue.ts` → `decideSend`).
   */
  const sendMessage = useCallback(async (sessionKey: string, content: string, options?: SendMessageOptions): Promise<boolean> => {
    // IL MOMENTO GIUSTO per chiedere le notifiche: hai appena creato un'attesa.
    // Non apre niente da solo — arma soltanto l'invito, che compare solo se
    // chiedere non sarebbe una bugia (permesso non ancora negato, push
    // disponibile, «non ora» mai detto). Vedi `state/pushAsk.ts`.
    armPushAsk();

    // Una domanda a schermo si risponde anche SCRIVENDO, non solo dal pannello.
    //
    // Il turno parcheggiato su un ask resta "in volo": `/api/chat` risponde 409
    // e il ramo qui sotto accoderebbe: il messaggio aspetterebbe la fine di un
    // turno che finisce solo rispondendo. Lo stallo dura fino allo scadere
    // dell'ask (90 min) o a uno «ferma» — e nel frattempo l'umano crede di aver
    // risposto. Qui il testo prende la strada del pannello (`tool-response`),
    // che è la strada che sblocca davvero il turno.
    //
    // `answerFromText` dice di no quando la domanda ha una forma che la prosa
    // non riempie (domande multiple, elicitation): lì si torna al giro normale
    // e il pannello resta l'unica strada, come prima.
    const ask = findPendingAsk(messagesRef.current[sessionKey]);
    const answer = ask ? answerFromText(ask, content) : null;
    if (ask && answer) {
      try {
        await chatApi.toolResponse(sessionKey, ask.toolCallId, answer);
        return true;
      } catch (e) {
        // 404 = qualcuno ha già risposto (l'altra finestra, o il pannello):
        // il turno è ripartito, quindi il testo è un messaggio normale e
        // prosegue per la sua strada. Gli altri errori li vede l'umano.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no pending input/i.test(msg)) {
          setError(`Risposta non consegnata: ${msg}`);
          return false;
        }
      }
    }

    const busy = isSendLocked(sessionKey) || !!streamingRef.current[sessionKey];
    const decision = decideSend({ busy, queued: getTurnQueue(sessionKey).length });

    if (decision === 'queue') {
      enqueueTurn(sessionKey, content, options);
      return true;
    }

    if (decision === 'queue-then-drain') {
      // C'era già una coda ferma (tipico dopo uno stop): questo messaggio va in
      // FONDO e riparte dalla testa, altrimenti scavalcherebbe quello che
      // l'umano aveva scritto prima. Parte tutta la coda in un turno solo — il
      // nuovo messaggio compreso, se le opzioni combaciano.
      enqueueTurn(sessionKey, content, options);
      const batch = claimQueuedTurns(sessionKey, CLAIM_CLIENT_ID);
      if (batch.length === 0) return true;
      const turn = mergeBatch(batch);
      return performSend(sessionKey, turn.content, turn.options, () => requeueFront(sessionKey, batch))
        .finally(() => releaseClaim(sessionKey, CLAIM_CLIENT_ID));
    }

    return performSend(sessionKey, content, options);
  }, [performSend, streamingRef]); // `streamingRef` e' uno specchio (useRefMirror): stesso oggetto a ogni render, quindi elencarlo non ridichiara nulla — serve solo a non lasciare un avviso exhaustive-deps che coprirebbe quelli veri.

  // Keep sendMessage ref in sync for stream:end auto-drain
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  // Deps VUOTE, ed e' il punto di tutto lo spostamento. Prima questa callback
  // dipendeva da `messages`, quindi cambiava identita' a ogni token: qualunque
  // `memo` a valle era carta straccia, perche' la prop arrivava sempre nuova.
  // Adesso e' stabile per tutta la vita del componente, e chi la riceve puo'
  // finalmente non ri-renderizzarsi.
  const getSessionMessages = useCallback((sessionKey: string): ChatMessage[] => {
    const src = getSessionMessagesFromStore(sessionKey);
    const cache = filteredMessagesCacheRef.current;
    const hit = cache.get(sessionKey);
    // Same source array ⇒ same filtered result: return the cached reference so
    // callers (and their useMemos) can bail on identity.
    if (hit && hit.src === src) return hit.out;
    const out = src.filter(msg => !isContextMessage(msg.content));
    cache.set(sessionKey, { src, out });
    return out;
  }, []);

  const EMPTY_MARKERS = useRef<CompactionMarker[]>([]).current;
  const getCompactionMarkers = useCallback((sessionKey: string): CompactionMarker[] => {
    return compactionMarkers[sessionKey] || EMPTY_MARKERS;
  }, [compactionMarkers, EMPTY_MARKERS]);

  const isSessionLoading = useCallback((sessionKey: string): boolean => {
    return loading[sessionKey] || false;
  }, [loading]);

  const isSessionStreaming = useCallback((sessionKey: string): boolean => {
    return streaming[sessionKey] || false;
  }, [streaming]);

  const isSessionThinking = useCallback((sessionKey: string): boolean => {
    return thinking[sessionKey] || false;
  }, [thinking]);

  /** Vero se il turno di questa sessione l'ha fermato l'umano e non ne è ancora partito un altro. */
  const wasSessionStopped = useCallback((sessionKey: string): boolean => {
    return stoppedByUser[sessionKey] || false;
  }, [stoppedByUser]);

  /**
   * Ferma lo stream. Risolve a `true` SOLO se il server ha davvero buttato via
   * la chat: è quel `true` che fa chiudere la pane a chi chiama, e archiviare
   * il topic alla riga in sidebar.
   *
   * La frenata è immediata e sincrona (freno della coda, `stoppedByUser`,
   * abort dell'SSE): quello che aspetta la risposta è solo il ramo DISTRUTTIVO.
   * Prima non aspettava, e decideva da sé con un predicato più permissivo di
   * quello del server: il 10 agosto 2026 lo Stop su un primo turno lungo otto
   * minuti ha svuotato la pagina e chiuso la pane mentre il server rifiutava
   * («il turno aveva già prodotto lavoro») e teneva tutto su disco. Vedi
   * `stopSessionPolicy.ts` e `shared/clear-messages-policy.ts`.
   */
  const stopSession = useCallback(async (sessionKey: string): Promise<boolean> => {
    // PRIMA di tutto il resto: «ferma» vuol dire fermo. L'abort qui sotto fa
    // finire lo stream, e la fine di uno stream è ciò che fa partire la coda —
    // per questo il freno si alza per primo e in modo DUREVOLE (le altre
    // finestre vedono solo «lo stream è finito», e ripartirebbero a spedire).
    // Era il guasto più grosso della coda: premere «ferma» faceva PARTIRE il
    // messaggio successivo. La coda resta dov'è, visibile nel badge del
    // composer: si corregge, si butta o riparte scrivendo il messaggio dopo.
    holdQueue(sessionKey);
    // Chi ha fermato il turno lo sa solo questa riga: da qui in poi la pagina è
    // indistinguibile da una risposta mai arrivata, e il composer accusava la
    // connessione al posto tuo.
    setStoppedByUser(prev => ({ ...prev, [sessionKey]: true }));
    const controller = abortControllersRef.current[sessionKey];
    if (controller) {
      controller.abort();
    }

    // Proposta di cancellazione, non decisione. Serve `hydratedSessionsRef`:
    // finché `loadHistory` non è passata, `messagesRef.current[sessionKey]` è
    // vuota per ragioni che non c'entrano col contenuto (mount iniziale, hot
    // reload, riaggancio del WS) e direbbe «primo messaggio» su un thread che
    // il server ha su disco. Il predicato è quello del server, importato:
    // `shared/clear-messages-policy.ts`.
    const hydrated = hydratedSessionsRef.current.has(sessionKey);
    const msgs = messagesRef.current[sessionKey] || [];
    const proposeWipe = decideClientWipeOnStop(hydrated, msgs);

    // Tell the server to abort — also clear server-side messages if first message
    let clearedByServer = false;
    try {
      const res = await chatApi.abort(sessionKey, proposeWipe);
      // `cleared` è l'unica parola che conta: il server ricontrolla sul DB e
      // vede anche le righe fuori dal ramo attivo, che qui non si vedono.
      // Assente (server vecchio, richiesta fallita) ⇒ non si butta niente.
      clearedByServer = proposeWipe && (res as { cleared?: boolean })?.cleared === true;
    } catch {
      clearedByServer = false;
    }

    if (clearedByServer) {
      // Clear session entirely — the chat is brand new
      setMessages(prev => ({ ...prev, [sessionKey]: [] }));
      clearCachedMessages(sessionKey);
      // We just emptied the local map; future stop clicks on this key
      // must re-hydrate from the server before they can wipe again.
      hydratedSessionsRef.current.delete(sessionKey);
    } else if (!dropEmptyTurn(sessionKey)) {
      // Il turno aveva prodotto qualcosa (mezza frase, un ragionamento, una tool
      // call): resta, si toglie solo lo stato "in corso". Se non aveva prodotto
      // niente la bolla se n'è già andata qui sopra — il server fa lo stesso
      // sulla riga, così lo stop non lascia un vuoto né in pagina né in DB.
      updateLastMessage(sessionKey, { partial: false });
    }

    // Il nome si dimentica DOPO la finalizzazione, per la stessa ragione di
    // `stream:end`: la riga qui sopra deve ancora trovare la bolla del turno e
    // non «l'ultima», che a turno con sotto-agenti non è più lei.
    streamMessageIdRef.current.end(sessionKey);

    return clearedByServer;
  }, [updateLastMessage, dropEmptyTurn]);

  const loadHistory = useCallback(async (sessionKey: string): Promise<boolean> => {
    // Skip entirely if sendMessage is actively streaming via SSE — it owns the state
    if (localSSESessionsRef.current.has(sessionKey)) return true;

    // Dedup rapid re-fetches: a tab switch in StandaloneChatGroup re-mounts
    // ChatPane, whose mount effect calls loadHistory. If we just fetched
    // this session's history a few seconds ago AND we have non-empty cached
    // messages, skip — WS keeps the cache fresh in between, so the user
    // sees the existing messages instantly with no spinner flash.
    const lastFetchedAt = lastHistoryFetchAtRef.current.get(sessionKey);
    if (lastFetchedAt && Date.now() - lastFetchedAt < HISTORY_DEDUP_MS) {
      const cached = messagesRef.current[sessionKey];
      if (cached && cached.length > 0) return true;
    }

    // Collapse concurrent callers onto the in-flight request.
    if (inFlightHistoryRef.current.has(sessionKey)) return true;
    inFlightHistoryRef.current.add(sessionKey);

    try {
      setError(null);
      setLoading(prev => ({ ...prev, [sessionKey]: true }));
      // Clear stale streaming/thinking state before server confirms the real state
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      
      const response = await chatApi.getHistory(sessionKey, { limit: HISTORY_FETCH_ALL });

      const chatMessages: ChatMessage[] = response.messages
        .filter(msg => !isContextMessage(msg.content))
        .map(msg => ({
          ...msg,
          id: msg.id || generateMessageId(),
          content: cleanInvisibleMarkers(msg.content || ''),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      // Merge with any messages that arrived via WS during the fetch (cross-window
      // sync race). Server history is the source of truth; we additively keep
      // local-only messages whose id isn't in the fetched set.
      setMessages(prev => {
        const existing = prev[sessionKey] || [];
        const merged = mergeFetchedHistory(existing, chatMessages);
        // La storia che arriva è quasi sempre quella che è già a schermo: se lo
        // è, questa riga restituisce l'array PRECEDENTE e React salta il render
        // — niente ri-misura delle altezze, niente lista che si ri-assembla
        // sotto gli occhi un secondo dopo il ricarico. Vedi reconcileMessages.
        const riconciliato = reconcileMessages(existing, merged);
        if (riconciliato === existing) return prev;
        return { ...prev, [sessionKey]: riconciliato };
      });

      // Compaction dividers (CHAT-COMPACT-01) — replace the session's set with
      // the server's authoritative list on every history load.
      const markers = (response as { compactionMarkers?: CompactionMarker[] }).compactionMarkers;
      if (Array.isArray(markers)) {
        setCompactionMarkers(prev => ({ ...prev, [sessionKey]: markers }));
      }

      // Cache messages for offline fallback
      cacheMessages(sessionKey, chatMessages);
      setCachedSessions(prev => {
        const next = new Set(prev);
        next.delete(sessionKey);
        return next;
      });
      // Mark this session as freshly loaded — subsequent re-mounts within
      // HISTORY_DEDUP_MS will short-circuit instead of re-fetching.
      lastHistoryFetchAtRef.current.set(sessionKey, Date.now());
      // The local messages map for this session is now backed by the
      // server's authoritative response; `stopSession` may rely on its
      // count to decide whether this is a brand-new chat that can be
      // wiped. Until this point a Stop click MUST refuse to wipe.
      hydratedSessionsRef.current.add(sessionKey);

      // Clear any queued outbound messages for this session — the server already has them
      const queue = getOutboundQueue();
      if (queue.some(q => q.sessionKey === sessionKey)) {
        setPendingQueue(removeQueueSession(queueStorage, OUTBOUND_QUEUE_KEY, sessionKey));
      }

      // Restore streaming state from server (for cross-device sync)
      if (response.isStreaming) {
        beginStreaming(sessionKey);
        if (response.streamState?.isThinking) {
          setThinking(prev => ({ ...prev, [sessionKey]: true }));
        }
        // Reset the stream timeout since we just reconnected
        resetStreamTimeout(sessionKey);
      }

      // Track orphaned messages (last message from user with no response)
      if (response.hasOrphanedMessage) {
        setOrphanedSessions(prev => new Set([...prev, sessionKey]));
      } else {
        setOrphanedSessions(prev => {
          const next = new Set(prev);
          next.delete(sessionKey);
          return next;
        });
      }

      return true;
    } catch (err) {
      console.error('Failed to load history:', err);
      // Serve cached messages silently when available — the error banner
      // was firing on every transient load failure (e.g. the first request
      // racing with WS connect on initial page mount), causing a visible
      // flash of "Cached messages — may not be current" before the retry
      // succeeded. Only surface the error when we genuinely have nothing
      // to show.
      const cached = getCachedMessages(sessionKey);
      if (cached && cached.length > 0) {
        setMessages(prev => ({ ...prev, [sessionKey]: cached }));
        setCachedSessions(prev => new Set([...prev, sessionKey]));
      } else {
        const existing = messagesRef.current[sessionKey];
        if (existing && existing.length > 0) {
          setCachedSessions(prev => new Set([...prev, sessionKey]));
        } else {
          // Genuinely empty state — show the error so the user knows
          // something is wrong.
          setError(err instanceof Error ? err.message : 'Failed to load history');
        }
      }
      return false;
    } finally {
      inFlightHistoryRef.current.delete(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
    }
  }, [resetStreamTimeout, beginStreaming]);

  useEffect(() => { loadHistoryRef.current = loadHistory; }, [loadHistory]);

  /** Edit a user message — creates a new branch and streams the assistant response. */
  /**
   * Shared SSE runner for the branch-forking endpoints (edit + regenerate).
   * Both fork a sibling on the server and stream the fresh assistant reply
   * over SSE with the identical wire shape — the only difference is which
   * endpoint opens the stream, so that's the injected part.
   */
  const runBranchStream = useCallback(async (
    sessionKey: string,
    openStream: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
    label: string,
  ): Promise<boolean> => {
    // Prevent concurrent edits/sends for the same session
    if (isSendLocked(sessionKey)) {
      console.warn(`[useChat] ${label} blocked — already sending for ${sessionKey}`);
      return false;
    }
    acquireSendLock(sessionKey);
    releaseHold(sessionKey); // anche modifica e rigenera sono un turno che riparte

    localSSESessionsRef.current.add(sessionKey);
    const abortController = new AbortController();
    abortControllersRef.current[sessionKey] = abortController;

    try {
      setError(null);
      beginStreaming(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: true }));

      const stream = await openStream(abortController.signal);
      if (!stream) throw new Error('No stream received');

      // Reload the full thread from server (the edit endpoint created the branch)
      // We do this to get the updated thread with the new branch
      const historyResponse = await chatApi.getHistory(sessionKey, { limit: HISTORY_FETCH_ALL });
      const chatMessages: ChatMessage[] = historyResponse.messages
        .filter(msg => !isContextMessage(msg.content))
        .map(msg => ({
          ...msg,
          id: msg.id || generateMessageId(),
          content: cleanInvisibleMarkers(msg.content || ''),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      setMessages(prev => ({
        ...prev,
        [sessionKey]: chatMessages,
      }));
      hydratedSessionsRef.current.add(sessionKey);

      // Now process the SSE stream for the assistant response
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = stream.getReader();
      } catch (e) {
        await stream.cancel();
        throw e;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let isInThinking = false;

      // Add a placeholder partial assistant message
      addMessage(sessionKey, {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        partial: true,
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let contentBatch = '';
          let thinkingBatch = '';
          let isDone = false;

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') { isDone = true; continue; }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                let chunk = delta.content;
                if (chunk.includes('<thinking>')) { isInThinking = true; setThinking(prev => ({ ...prev, [sessionKey]: true })); chunk = chunk.replace('<thinking>', ''); }
                if (chunk.includes('</thinking>')) { isInThinking = false; setThinking(prev => ({ ...prev, [sessionKey]: false })); chunk = chunk.replace('</thinking>', ''); }
                if (!isInThinking) chunk = cleanInvisibleMarkers(chunk);
                if (isInThinking) { thinkingBatch += chunk; }
                else if (chunk) { contentBatch += chunk; }
              }
            } catch {}
          }

          // Same coalescing as the sendMessage reader above — this branch has no
          // tool calls or tool results, so there is no `blocks` timeline to keep
          // ordered and the buffer can simply absorb every cycle.
          if (contentBatch || thinkingBatch) {
            bufferLiveDelta(sessionKey, contentBatch || undefined, thinkingBatch || undefined);
          }
          if (isDone) {
            flushLiveDeltas(sessionKey); // `partial:false` must not race the last token
            updateLastMessage(sessionKey, { partial: false });
          }
        }
      } finally {
        flushLiveDeltas(sessionKey);
        reader.releaseLock();
      }

      // Reload full history to get accurate sibling counts
      await loadHistory(sessionKey);
      // Anche questo è un turno che finisce: se qualcuno ha scritto mentre la
      // risposta si rigenerava, adesso tocca a lui.
      drainTurnQueueRef.current?.(sessionKey);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return true;
      console.error(`Failed to ${label}:`, err);
      setError(err instanceof Error ? err.message : `Failed to ${label}`);
      return false;
    } finally {
      releaseSendLock(sessionKey); // Release send lock
      clearSSEFailsafe(sessionKey); // lo stream è chiuso: niente abort in ritardo
      localSSESessionsRef.current.delete(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
    }
  }, [addMessage, updateLastMessage, loadHistory, bufferLiveDelta, flushLiveDeltas, clearSSEFailsafe, beginStreaming]);

  const editMessage = useCallback(
    (sessionKey: string, messageId: string, newContent: string): Promise<boolean> =>
      runBranchStream(sessionKey, (signal) => chatApi.editMessage(messageId, newContent, signal), 'edit message'),
    [runBranchStream],
  );

  /** Regenerate an assistant reply: fork a sibling branch under the same user
   *  message and re-stream. The previous answer stays reachable via the
   *  branch arrows — nothing is destroyed. */
  const regenerateMessage = useCallback(
    (sessionKey: string, messageId: string): Promise<boolean> =>
      runBranchStream(sessionKey, (signal) => chatApi.regenerateMessage(messageId, signal), 'regenerate message'),
    [runBranchStream],
  );

  /** Delete a message and its descendant branches; the server returns the
   *  repaired active thread (same contract as switchBranch). */
  const deleteMessage = useCallback(async (sessionKey: string, messageId: string): Promise<boolean> => {
    try {
      setError(null);
      const response = await chatApi.deleteMessage(messageId);

      const chatMessages: ChatMessage[] = (response.messages as HistoryMessage[])
        .filter((msg) => !isContextMessage(msg.content))
        .map((msg) => ({
          ...msg,
          id: msg.id || generateMessageId(),
          content: cleanInvisibleMarkers(msg.content || ''),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      setMessages(prev => ({
        ...prev,
        [sessionKey]: chatMessages,
      }));

      cacheMessages(sessionKey, chatMessages);
      return true;
    } catch (err) {
      console.error('Failed to delete message:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete message');
      return false;
    }
  }, []);

  /** Switch to a different branch at a message fork point. */
  const switchBranch = useCallback(async (sessionKey: string, messageId: string, branchIndex: number): Promise<boolean> => {
    try {
      setError(null);
      const response = await chatApi.switchBranch(messageId, branchIndex);

      const chatMessages: ChatMessage[] = (response.messages as HistoryMessage[])
        .filter((msg) => !isContextMessage(msg.content))
        .map((msg) => ({
          ...msg,
          id: msg.id || generateMessageId(),
          content: cleanInvisibleMarkers(msg.content || ''),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      setMessages(prev => ({
        ...prev,
        [sessionKey]: chatMessages,
      }));

      cacheMessages(sessionKey, chatMessages);
      return true;
    } catch (err) {
      console.error('Failed to switch branch:', err);
      setError(err instanceof Error ? err.message : 'Failed to switch branch');
      return false;
    }
  }, []);

  const appendMediaToLastAssistant = useCallback((sessionKey: string, mediaPaths: string[]) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastAssistantIdx = sessionMessages.findLastIndex(m => m.role === 'assistant');
      if (lastAssistantIdx < 0) return prev;

      const updated = [...sessionMessages];
      updated[lastAssistantIdx] = {
        ...updated[lastAssistantIdx],
        media: [...(updated[lastAssistantIdx].media || []), ...mediaPaths],
      };
      return { ...prev, [sessionKey]: updated };
    });
  }, []);

  /**
   * Dimentica le cache per-sessione di questo hook.
   *
   * `useChat` è una sola istanza per la vita dell'app, quindi queste mappe
   * crescerebbero con ogni topic mai aperta senza calare mai. Buttarle rende
   * anche corretto il rientro: senza, una sessione svuotata resterebbe segnata
   * come «già idratata» e `stopSession` si fiderebbe di un conteggio a zero che
   * non viene dal server (vedi `stopSessionPolicy.ts`).
   */
  const forgetSessionCaches = useCallback((sessionKey: string) => {
    filteredMessagesCacheRef.current.delete(sessionKey);
    lastHistoryFetchAtRef.current.delete(sessionKey);
    hydratedSessionsRef.current.delete(sessionKey);
    // Anche il nome della bolla in volo: i messaggi di questa sessione non ci
    // sono più (svuotata, o sfrattata dallo spazzino), quindi quel nome non
    // indica più niente e al rientro punterebbe a una riga che non esiste.
    streamMessageIdRef.current.end(sessionKey);
  }, []);

  const clearSession = useCallback((sessionKey: string) => {
    setMessages(prev => ({
      ...prev,
      [sessionKey]: [],
    }));
    clearCachedMessages(sessionKey);
    forgetSessionCaches(sessionKey);
  }, [forgetSessionCaches]);

  /**
   * Lo spazzino dei trascritti: restituisce la memoria delle chat che nessuno
   * guarda più.
   *
   * `useChat` è una sola istanza per la vita dell'app (montata in `App`), quindi
   * ogni mappa per-sessione qui dentro cresceva con OGNI topic mai aperta e non
   * calava mai — e i messaggi, che sono la voce grossa, vivono in
   * `messageStore`, dove non usciva niente per costruzione. Il tetto sulle pane
   * smonta la chat ma non tocca il suo trascritto: la pane sparisce, i suoi
   * diecimila messaggi restano.
   *
   * Chi resta lo decide `messageResidency` (modulo puro, testato); qui si
   * raccolgono i fatti e si applica. «Occupata» è l'unione di tutto ciò che
   * rende la copia in memoria più fresca di quella sul server: stream in corso,
   * invio in volo, fetch di cronologia aperta, coda in uscita o in attesa di
   * fine stream. Sfrattare una di quelle non ricaricherebbe il lavoro: lo
   * perderebbe.
   */
  const loadingRef = useRefMirror(loading);
  const thinkingRef = useRefMirror(thinking);
  const pendingQueueRef = useRefMirror(pendingQueue);
  useEffect(() => {
    const sweep = (overrides?: Partial<Omit<MessageResidencyInput, 'sessions' | 'now'>>): string[] => {
      const busy = new Set<string>();
      const addTruthy = (m: Record<string, boolean>) => {
        for (const [k, v] of Object.entries(m)) if (v) busy.add(k);
      };
      addTruthy(streamingRef.current);
      addTruthy(loadingRef.current);
      addTruthy(thinkingRef.current);
      for (const k of localSSESessionsRef.current) busy.add(k);
      for (const k of inFlightHistoryRef.current) busy.add(k);
      for (const k of Object.keys(abortControllersRef.current)) busy.add(k);
      for (const k of sendLockRef.current.keys()) busy.add(k);
      for (const q of pendingQueueRef.current) busy.add(q.sessionKey);

      const { evict } = decideMessageResidency({
        // Una sessione con dei messaggi ancora in coda è OCCUPATA: sfrattarne
        // i messaggi mentre il turno successivo deve ancora partire vorrebbe
        // dire ricaricare la history un istante dopo.
        sessions: listSessions().map(s => ({ ...s, busy: busy.has(s.key) || getTurnQueue(s.key).length > 0 })),
        now: Date.now(),
        budget: MESSAGE_RESIDENCY_BUDGET,
        maxIdleMessages: MESSAGE_RESIDENCY_MAX_IDLE_MESSAGES,
        minIdleMs: MESSAGE_MIN_IDLE_MS,
        ...overrides,
      });
      if (evict.length === 0) return [];

      // `evictSessions` rifiuta comunque le sessioni guardate: la politica e lo
      // store difendono la stessa invariante da due lati, e il ritorno dice
      // quali sono uscite DAVVERO.
      const gone = evictSessions(evict);
      if (gone.length === 0) return [];
      for (const k of gone) {
        forgetSessionCaches(k);
        sweptSessions += 1;
      }
      // I divisori di compattazione seguono il trascritto: tenerli sarebbe
      // tenere l'indice di un libro che non c'è più, e al rientro
      // `loadHistory` li rimpiazza con la lista autorevole del server.
      setCompactionMarkers(prev => {
        let touched = false;
        const next = { ...prev };
        for (const k of gone) {
          if (k in next) { delete next[k]; touched = true; }
        }
        return touched ? next : prev;
      });
      return gone;
    };

    /**
     * Lo stesso spazzino, a comando. Serve a due cose che il timer non copre:
     * rispondere a «perché questa chat si è ricaricata?» dalla console
     * (`__topicsMessageSweep()` dice esattamente quali sessioni escono, con
     * quali soglie), e permettere a un test di provare l'invariante senza
     * aspettare mezzo minuto di grazia più mezzo minuto di timer.
     *
     * Le soglie si possono forzare, l'invariante no: `evictSessions` rifiuta
     * comunque una sessione guardata, quindi nemmeno un `budget: 0` può
     * svuotare una lista a schermo.
     */
    (window as unknown as { __topicsMessageSweep?: typeof sweep }).__topicsMessageSweep = sweep;
    const t = setInterval(sweep, SWEEP_EVERY_MS);
    return () => {
      clearInterval(t);
      delete (window as unknown as { __topicsMessageSweep?: typeof sweep }).__topicsMessageSweep;
    };
  }, [forgetSessionCaches, streamingRef, loadingRef, thinkingRef, pendingQueueRef]);

  // Ritentativo del drain per gli item rinviati (sessione occupata). Un solo
  // timer alla volta; si autospegne quando la coda non rinvia più nulla.
  const drainRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainQueueRef = useRef<(() => Promise<void>) | null>(null);
  const DRAIN_RETRY_MS = 2_000;
  const scheduleDrainRetry = useCallback(() => {
    if (drainRetryRef.current) return;
    drainRetryRef.current = setTimeout(() => {
      drainRetryRef.current = null;
      void drainQueueRef.current?.();
    }, DRAIN_RETRY_MS);
  }, []);
  useEffect(() => () => {
    if (drainRetryRef.current) clearTimeout(drainRetryRef.current);
  }, []);

  // Drain outbound queue on reconnect.
  //
  // Invariante: la coda durevole si tocca UN ITEM ALLA VOLTA, e un item ne esce
  // solo quando è stato consegnato o deliberatamente scartato. La versione
  // precedente svuotava tutto in testa al drain e teneva gli item in una
  // variabile locale: bastava chiudere la tab a metà per perderli, e un item su
  // sessione occupata veniva semplicemente saltato — cioè cancellato. Vedi
  // `outboundQueue.ts` per la decisione item-per-item.
  const drainQueue = useCallback(async () => {
    // Prevent concurrent drains (e.g. rapid WS reconnects)
    if (drainingRef.current) return;
    drainingRef.current = true;

    let deferred = 0;
    try {
      const queue = getOutboundQueue();
      if (queue.length === 0) return;

      const now = Date.now();

      for (const item of queue) {
        const verdict = decideQueuedMessage(item, {
          now,
          locked: isSendLocked(item.sessionKey),
          sessionMessages: messagesRef.current[item.sessionKey] || [],
        });

        if (verdict.action === 'expire') {
          // Cambia coda, non evapora: resta offerto in retry anche dopo un reload.
          moveToExpired(queueStorage, item);
          setExpiredMessages(getExpiredQueue());
          setPendingQueue(getOutboundQueue());
          continue;
        }

        if (verdict.action === 'defer') {
          // La sessione sta già spedendo: l'item RESTA in coda. Nessuna scrittura.
          deferred += 1;
          continue;
        }

        if (verdict.action === 'drop') {
          setPendingQueue(removeQueueItem(queueStorage, OUTBOUND_QUEUE_KEY, item));
          continue;
        }

        // Un-mark the queued user message
        setMessages(prev => {
          const sessionMessages = prev[item.sessionKey] || [];
          const idx = sessionMessages.findIndex(
            m => m.role === 'user' && m.partial && m.content === item.content
          );
          if (idx >= 0) {
            const updated = [...sessionMessages];
            updated[idx] = { ...updated[idx], partial: false };
            return { ...prev, [item.sessionKey]: updated };
          }
          return prev;
        });

        try {
          // La chiave del tentativo di prima viaggia col rinvio: se il server
          // quel messaggio l'aveva già preso, risponde `duplicate_message` e
          // `sendMessage` lo lascia andare invece di scriverlo due volte. È ciò
          // che rende sicura la rimozione qui sotto — prima non lo era, e il
          // commento che segue lo diceva.
          await sendMessageRef.current!(item.sessionKey, item.content, { ...item.options, clientMessageId: item.id });
          // Esce di coda solo ADESSO, a tentativo concluso: per tutta la durata
          // dell'invio è rimasto scritto su disco, quindi una tab che muore a
          // metà lo ritrova. Si toglie anche quando `sendMessage` ha risposto
          // `false`, perché in quel caso è LUI che ha già deciso il destino del
          // messaggio — o l'ha ri-accodato da sé (rete giù, id nuovo, che questa
          // rimozione per id vecchio non tocca) o ha alzato l'errore lasciando
          // il messaggio visibile in chat. Tenerlo qui significherebbe
          // rispedirlo a un server che potrebbe averlo già preso.
          setPendingQueue(removeQueueItem(queueStorage, OUTBOUND_QUEUE_KEY, item));
        } catch {
          // `sendMessage` non lancia mai: se succede è un bug, e l'item resta in
          // coda esattamente dov'è. Si riprova al prossimo giro.
          deferred += 1;
        }
      }
    } finally {
      drainingRef.current = false;
      // Clear any "queued" error banner now that we've processed the queue
      setError(prev => (prev?.includes('queued') ? null : prev));
      // Qualcosa è rimasto in coda per una sessione occupata: il lock si
      // libererà da solo (fine turno, o scadenza a 60s) ma nessun evento ci
      // richiamerebbe. Ripassiamo noi, finché la coda non si svuota o gli item
      // scadono. Senza questo, "resta in coda" diventerebbe "resta lì per
      // sempre" — meno grave della perdita, ma comunque un messaggio non
      // spedito.
      if (deferred > 0) scheduleDrainRetry();
    }
  }, [scheduleDrainRetry]);
  drainQueueRef.current = drainQueue;

  const retryExpired = useCallback(async (item: QueuedMessage) => {
    const key = queueItemKey(item);
    const without = (list: QueuedMessage[]) => list.filter(m => queueItemKey(m) !== key);
    writeQueue(queueStorage, EXPIRED_QUEUE_KEY, without(getExpiredQueue()));
    setExpiredMessages(prev => without(prev));
    try {
      // Anche il retry a mano porta la chiave di allora. Quasi sempre il server
      // l'avrà già dimenticata (scade in mezz'ora, e un messaggio scaduto è più
      // vecchio) e riparte pulito: portarla non può causare un doppione, può
      // solo evitarne uno.
      await sendMessageRef.current?.(item.sessionKey, item.content, { ...item.options, clientMessageId: item.id });
    } catch {
      setExpiredMessages(enqueue(queueStorage, EXPIRED_QUEUE_KEY, item));
    }
  }, []);

  const clearExpired = useCallback(() => {
    writeQueue(queueStorage, EXPIRED_QUEUE_KEY, []);
    setExpiredMessages([]);
  }, []);

  const isSessionCached = useCallback((sessionKey: string): boolean => {
    return cachedSessions.has(sessionKey);
  }, [cachedSessions]);

  return {
    sendMessage,
    editMessage,
    regenerateMessage,
    deleteMessage,
    switchBranch,
    stopSession,
    getSessionMessages,
    getCompactionMarkers,
    isSessionLoading,
    isSessionStreaming,
    reconcileServerStreams,
    isSessionThinking,
    wasSessionStopped,
    isSessionCached,
    loadHistory,
    appendMediaToLastAssistant,
    clearSession,
    addMessageFromWS: addMessage, // For real-time sync across windows
    onWSMessage,
    registerWSHandler,
    drainQueue,
    expiredMessages,
    retryExpired,
    clearExpired,
    pendingQueueSize: pendingQueue.length,
    getStreamQueueSize: (sessionKey: string) => getTurnQueue(sessionKey).length,
    error,
    gatewayConnected,
    isSessionOrphaned: (sessionKey: string) => orphanedSessions.has(sessionKey),
    isOwnStream: (sessionKey: string) => localSSESessionsRef.current.has(sessionKey),
  };
}
