import type { ChatMessage } from '../types';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { type MediaSizes } from '../components/Chat/mediaBox';
import {
mergeBatch,
requeueFront,
type QueuedTurn
} from '../state/chatQueue';
import {
getAllMessages,
// Importata con l'alias storico: e' una funzione di MODULO, quindi stabile per
// definizione — ed e' anche il motivo per cui non compare in nessuna lista di
// dipendenze, mentre il vecchio `setMessages` di `useState` ci compariva.
updateMessages as setMessages
} from '../state/messageStore';
import { type TurnRef } from '../state/serverTurn';
import { flagMapRef,flagSetter,getSessionFlag } from '../state/sessionFlags';
import {
EXPIRED_QUEUE_KEY,
OUTBOUND_QUEUE_KEY,
readQueue,
type QueueStorage,
type QueuedMessage
} from './outboundQueue';
import { afterUnfinishedSend } from './ownBubble';
import { CLIENT_MESSAGE_ID_PREFIX } from './streamCatchupMerge';


// The turn flags' setters, readers and live refs: module constants, so every
// callback that uses them stays stable (see `state/sessionFlags.ts`).
export const setLoading = flagSetter('loading');

export const setStreaming = flagSetter('streaming');

export const setThinking = flagSetter('thinking');

export const setStoppedByUser = flagSetter('stopped');

export const loadingRef = flagMapRef('loading');

export const streamingRef = flagMapRef('streaming');

export const thinkingRef = flagMapRef('thinking');

export const stoppedByUserRef = flagMapRef('stopped');

export const isSessionLoading = (sessionKey: string): boolean => getSessionFlag('loading', sessionKey);

export const isSessionStreaming = (sessionKey: string): boolean => getSessionFlag('streaming', sessionKey);

export const isSessionThinking = (sessionKey: string): boolean => getSessionFlag('thinking', sessionKey);

/** Vero se il turno di questa sessione l'ha fermato l'umano e non ne è ancora partito un altro. */
export const wasSessionStopped = (sessionKey: string): boolean => getSessionFlag('stopped', sessionKey);



// The chat still ends up holding the COMPLETE thread - never a fixed window. An
// old fixed limit of 100 silently dropped the head of long topics and the chat
// rendered "tagliata". The thread now arrives in two requests: the tail
// (`HISTORY_FIRST_PAGE`) that lifts the curtain, then everything before it
// (`HISTORY_FETCH_ALL` + `before`), merged only while nobody is looking at the
// list or when somebody asks for it (`completeHistory` below). The paths that
// must hold the whole thread at once (branch switch, delete, the reload after
// an edit) keep asking for it in one go.

/**
 * Ogni quanto passa lo spazzino dei trascritti. Mezzo minuto: la grazia della
 * politica è di un minuto, quindi nulla può essere sfrattato prima di averla
 * superata, e il costo di un giro è contare le chiavi di un oggetto.
 */
export const SWEEP_EVERY_MS = 30_000;


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
export const STREAM_TIMEOUT_MS = 3 * 60 * 1000;


// Quanto aspettiamo che il nostro SSE si chiuda da solo dopo che il server ha
// annunciato la fine del turno via WS. Nel caso sano `[DONE]` arriva nello
// stesso momento; questa finestra serve solo a non abortire un drain lento.
export const SSE_FAILSAFE_MS = 5000;


export const generateMessageId = () => `${CLIENT_MESSAGE_ID_PREFIX}${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;


// Topic/project/browser control moved from {{...}} markers to MCP/SDK tools,
// so the model no longer emits markers and stored history was backfilled clean.
// This is now a no-op kept at the call sites as a thin seam (cheap identity) in
// case any legacy content needs future normalisation.
export const cleanInvisibleMarkers = (text: string): string => text;


// Filter out internal gateway context messages
export const isContextMessage = (content: string): boolean => {
  return content.startsWith('[Chat messages since your last reply');
};


/** How `loadHistory` reads a session. */
export interface LoadHistoryOptions {
  /** Past the 5 s dedup: rows changed with no frame to carry them. */
  fresh?: boolean;
  /** The turn is known live here: it stays lit until the answer says otherwise. */
  keepLit?: boolean;
}


export interface StopSessionOptions {
  /** «Send now»: stop the turn to send the queue, leave its sub-agents working. */
  sendNow?: boolean;
}


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
  /**
   * The id of the user's bubble when it is already on screen: a draft's first
   * send stages it at the key, before the topic exists (`state/firstSend.ts`).
   * The send then adds no second row: the one on screen is this message.
   */
  userMessageId?: string;
  /** This message already left once under `clientMessageId`, and the server may hold it (`QueuedTurn.sent`). */
  mayBeStored?: boolean;
  /** The sizes of the pictures the person attached, read in the composer: the bubble's pictures have their box before their bytes (`Chat/attachmentSizes.ts`). */
  mediaSizes?: MediaSizes;
}


export type { QueuedMessage };


/**
 * Adattatore verso `localStorage` per le due code di `outboundQueue.ts`. I
 * metodi risolvono `localStorage` alla chiamata, non alla definizione: dove non
 * esiste, l'errore cade nel try/catch del modulo invece che all'import.
 */
export const queueStorage: QueueStorage = {
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
export const CLAIM_CLIENT_ID = (() => {
  try { return crypto.randomUUID(); } catch { return `w-${Math.random().toString(36).slice(2)}-${Date.now()}`; }
})();


/** Ritenta del drain quando la sessione è ancora occupata: 10 × 200 ms = 2 s. */
export const TURN_DRAIN_RETRY_MS = 200;

export const TURN_DRAIN_MAX_ATTEMPTS = 10;


export const getOutboundQueue = (): QueuedMessage[] => readQueue(queueStorage, OUTBOUND_QUEUE_KEY);


/**
 * An outbound resend that meets a turn in flight waits in the turn queue,
 * under the key it already left with (`enqueueTurn`): its bubble, still
 * waiting for a name, leaves the thread, since the queue now shows it.
 */
export function withdrawWaitingBubble(sessionKey: string, key: string | undefined): void {
  if (!key) return;
  setMessages(prev => {
    const rows = prev[sessionKey] ?? [];
    const next = afterUnfinishedSend(rows, key, undefined, 'withdraw');
    return next === rows ? prev : { ...prev, [sessionKey]: next };
  });
}


/**
 * A claimed batch as ONE send: merged words, the head's id as the key. If it
 * fails it goes back as it was, or, when the server may hold it, as one
 * `sent` item with the words it left with (`requeueFront`).
 */
export function batchSend(sessionKey: string, batch: QueuedTurn[]) {
  const turn = mergeBatch(batch);
  return {
    content: turn.content,
    options: { ...turn.options, clientMessageId: batch[0]!.id, ...(batch[0]!.sent ? { mayBeStored: true } : {}) },
    restore: (waitsFor?: TurnRef, mayBeStored?: boolean) => requeueFront(sessionKey, batch, waitsFor, mayBeStored ? turn : undefined),
  };
}

export const getExpiredQueue = (): QueuedMessage[] => readQueue(queueStorage, EXPIRED_QUEUE_KEY);


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
export const messagesRef = {
  get current(): Record<string, ChatMessage[]> {
    return getAllMessages();
  },
};
