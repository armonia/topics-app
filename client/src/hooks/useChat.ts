import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi } from '../lib/api';
import type { ChatMessage, CompactionMarker, ContentBlock, ToolCall, WSFrameRow, WSMessage } from '../types';
import { decideClientWipeOnStop } from './stopSessionPolicy';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { isEmptyAssistantTurn } from '../../../shared/empty-turn';
import { SEND_NOW_STOP_CAUSE } from '../../../shared/types';
import { mergeMediaSizes } from '../components/Chat/mediaBox';
import { registerFeatureWeight, roughBytes } from '../lib/featureWeight';
import { apiFetch } from '../lib/shell/net';
import {
getQueue as getTurnQueue,
holdQueue
} from '../state/chatQueue';
import {
resetHistoryCompleteness
} from '../state/historyCompleteness';
import { noteLocalCopyRows } from '../state/localCopyRows';
import {
MESSAGE_MIN_IDLE_MS,
MESSAGE_RESIDENCY_BUDGET,
MESSAGE_RESIDENCY_MAX_IDLE_MESSAGES,
decideMessageResidency,
type MessageResidencyInput,
} from '../state/messageResidency';
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
import { serverTurnOf } from '../state/serverTurn';
import { reconcileOrphanStreams } from '../state/signals';
import {
beginStreamTokenRate,
finishStreamTokenRate,
forgetStreamTokenRate,
recordStreamText,
} from '../state/streamTokenRate';
import { cacheMessages, clearCachedMessages, getInitialMessages, pruneMessageCache } from './chatMessageCache';
import { SSE_FAILSAFE_MS, STREAM_TIMEOUT_MS, SWEEP_EVERY_MS, generateMessageId, getExpiredQueue, getOutboundQueue, isContextMessage, isSessionLoading, isSessionStreaming, isSessionThinking, loadingRef, messagesRef, setLoading, setStoppedByUser, setStreaming, setThinking, stoppedByUserRef, streamingRef, thinkingRef, wasSessionStopped, type LoadHistoryOptions, type SendMessageOptions, type StopSessionOptions } from './chatShared';
import { HeldToolFacts, patchToolCallOrFollow, withAnnouncedToolCall } from './heldToolFacts';
import { LiveTurnIds, frameTargetIndex, lateStartContent, liveAssistantIndex, queueLateDelta, shouldFillFromBroadcast, takeLateDeltas, type LateDelta } from './liveTurn';
import {
type QueuedMessage
} from './outboundQueue';
import { insertBeside } from './ownBubble';
import { shouldAdoptIntoPlaceholder } from './streamCatchupMerge';
import { useQueueRetry } from './chatQueue';
import { useBranchActions } from './chatBranches';
import { useHistoryLoader } from './chatHistory';
import { useSendPipeline } from './chatSend';
import { useStreamEvents } from './chatStreamEvents';
import { TextPaintGate } from './textPaintGate';
import { withPartialResult } from './toolUpdatePatch';
import { useRefMirror } from './useRefMirror';

export type { LoadHistoryOptions, QueuedMessage, SendMessageOptions, StopSessionOptions };

/**
 * Quante sessioni lo spazzino ha restituito da quando la finestra è aperta.
 * Serve alla sonda di memoria: senza, «entries: 7» non distingue «poche chat
 * aperte» da «ne ho aperte cento e le sto potando».
 */
let sweptSessions = 0;

// Shared stable empty array so getSessionMessages returns a reference-equal
// result for a session with no messages (a fresh `[]` per call would be a cache
// miss every time and hand consumers a new identity each render).

let messageStoreHydrated = false;


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
    const fromCopy = getInitialMessages();
    replaceAllMessages(fromCopy);
    noteLocalCopyRows(Object.keys(fromCopy));
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
  // The turn flags (loading, streaming, thinking, stopped) live in
  // `state/sessionFlags.ts`, not in this hook's state: `App` calls `useChat`,
  // so a `useState` here re-rendered the whole app on a `stream:start` of a
  // topic nobody was looking at. Their setters, keeping the `useState` updater
  // shape, and their readers are module constants at the top of this file.
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
  // Keyed by sessionKey like `streaming`/`loading`/`thinking`: `useChat` is
  // mounted ONCE for the whole app, so a single string here was painted under
  // EVERY composer on screen and cleared by whichever session sent next.
  const [error, setError] = useState<Record<string, string | null>>({});
  const [gatewayConnected, setGatewayConnected] = useState(true); // Assume connected until told otherwise
  const [orphanedSessions, setOrphanedSessions] = useState<Set<string>>(new Set());
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
    turnStartsRef.current.set(sessionKey, (turnStartsRef.current.get(sessionKey) ?? 0) + 1);
    beginStreamTokenRate(sessionKey);
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
  /** Whether a session's last live text is on screen yet (`textPaintGate.ts`). */
  const textPaintGateRef = useRef(new TextPaintGate());
  /**
   * Per session, the WS frames that came behind a `stream:end` held for its
   * last words to be painted: they run after it, in their order.
   */
  const heldBehindEndRef = useRef<Map<string, WSMessage[]>>(new Map());
  // Watchdog per il caso "il server ha finito, il nostro SSE no": vedi
  // scheduleSSEFailsafe.
  const sseFailsafeRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // `loadHistory` è definito molto più in basso: il failsafe lo raggiunge da
  // qui senza dipendere dall'ordine di dichiarazione.
  const loadHistoryRef = useRef<((sk: string, opts?: LoadHistoryOptions) => Promise<boolean>) | null>(null);
  // Track sessions with active local SSE streams (to avoid double content from WS broadcast)
  const localSSESessionsRef = useRef<Set<string>>(new Set());
  // The turn's end reached this window while its own SSE held the session: the
  // gate below swallows that frame, and a reply cut short must not relight on
  // a history snapshot taken before it.
  const endedDuringOwnSseRef = useRef<Set<string>>(new Set());
  // Sessions whose own reply body has closed while its reload is still in
  // flight, and those of them for which the gate then swallowed a frame of the
  // turn. The reply carries nothing more by then, and the reload's snapshot can
  // predate the frame: if the turn is still live, the frame is in neither.
  const ownReplyClosedRef = useRef<Set<string>>(new Set());
  // Question and permission frames that reached this window before their row (`heldToolFacts.ts`).
  const heldToolFactsRef = useRef(new HeldToolFacts());
  const swallowedAfterReplyRef = useRef<Set<string>>(new Set());
  // Rows a `message:new` added while this window's own SSE held the session,
  // by id: written beside the turn (a stopped-by-parent card), they can be
  // younger than the snapshot the end of that SSE reloads, which replaces the
  // whole thread and would drop them again.
  const wsRowsDuringOwnSseRef = useRef<Map<string, Set<string>>>(new Map());
  // The key of the send this window has in flight, while its SSE holds the
  // session: where a row announced beside it goes (`insertBeside`).
  const ownSendKeyRef = useRef<Map<string, string>>(new Map());
  // A late answer's opening flag whose chunk cleaned to nothing, by message id
  // (see `carryLateStart`).
  const pendingLateStartRef = useRef<Set<string>>(new Set());
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
  // A `fresh` read that met one in flight, with the options it asked for: the
  // read again keeps them, or a `keepLit` one blinks the Stop off meanwhile.
  const rereadHistoryRef = useRef<Map<string, LoadHistoryOptions>>(new Map());
  // How many turns of each session this window lit and ended (`stream:end`).
  // A history answer that a start or an end overtook in flight no longer
  // describes the current turn: `loadHistory` compares the counts.
  const turnStartsRef = useRef<Map<string, number>>(new Map());
  const turnEndsRef = useRef<Map<string, number>>(new Map());
  // Rows the server DELETED at a turn end (`stream:end.discardedMessageId`):
  // an empty turn that was stopped, or woken with nothing to say. An answer
  // read before the delete still carries them, and they must not come back.
  const discardedRowsRef = useRef<Map<string, Set<string>>>(new Map());
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
  // Per-session count of consecutive polls where the server said "not streaming"
  // while we still showed it streaming. Drives the orphan-clear threshold.
  const streamMissRef = useRef<Map<string, number>>(new Map());
  // Ref for sendMessage to allow stream:end to trigger next queued message
  const sendMessageRef = useRef<((sk: string, content: string, opts?: SendMessageOptions) => Promise<boolean>) | null>(null);
  // Il drain della coda del turno si richiama da sé (ritenta se la sessione è
  // ancora occupata) e viene chiamato da `stream:end`, che è definito più su.
  const drainTurnQueueRef = useRef<((sk: string, attempt?: number) => void) | null>(null);
  /**
   * A turn is over, whoever says so: forget the name of its in-flight bubble
   * and let the queue go. Every authoritative end of a turn goes through here.
   *
   * The queue used to drain on `stream:end` only. A turn that dies without
   * one (watchdog, orphan reconciler) or that ends while this client is not
   * listening (reload, relaunch, socket lost for the second it takes) left
   * the dashed "to send" bubble in the transcript forever, with nothing to
   * fire it. `drainTurnQueue` already refuses to run while the queue is held
   * by a stop, while a turn is in flight, or when the head was claimed by
   * another window, so calling it from more places is safe by construction.
   */
  const settleTurn = useCallback((sessionKey: string) => {
    finishStreamTokenRate(sessionKey);
    streamMessageIdRef.current.end(sessionKey);
    drainTurnQueueRef.current?.(sessionKey);
  }, []);

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
          const res = await apiFetch('/api/topics/streaming');
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
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setLoading(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        // Il turno è morto senza `stream:end`: il nome della sua bolla muore con
        // lui, o il turno DOPO scriverà lì dentro invece che nel segnaposto nuovo.
        // And the queue, if any, goes: a dead turn is a finished turn.
        settleTurn(sessionKey);
      })();
    }, STREAM_TIMEOUT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `resetStreamTimeoutRef` NON può stare qui: è dichiarato tre righe più sotto, quindi valutare l'array di dipendenze lo leggerebbe nella sua temporal dead zone. Il corpo della callback lo legge invece quando il timer scatta, a dichiarazione avvenuta — ed è tutto il punto dello specchio. Il ref è comunque stabile (useRefMirror restituisce sempre lo stesso oggetto), quindi non sarebbe una dipendenza reale.
  }, []);
  // La callback si riarma da sé: lo specchio rompe il ciclo di dichiarazione, con
  // l'helper che questo file usa già per lo stesso scopo.
  const resetStreamTimeoutRef = useRefMirror(resetStreamTimeout);

  /**
   * A live frame of a turn this window had already settled lights it again.
   *
   * `stream:start` was the only frame that lit a turn, and it came and went: a
   * window that took the turn for over (the registry dropped it, the reply's
   * SSE closed early) showed a finished chat with no Stop while the answer kept
   * arriving. A turn the person stopped stays stopped: the frames still in
   * flight before the server's abort must not bring the Stop back.
   */
  const relightSettledTurn = useCallback((sessionKey: string, messageId?: string) => {
    if (streamingRef.current[sessionKey] || stoppedByUserRef.current[sessionKey]) return;
    beginStreaming(sessionKey);
    resetStreamTimeout(sessionKey);
    if (messageId) streamMessageIdRef.current.begin(sessionKey, messageId);
  }, [beginStreaming, resetStreamTimeout]);

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
    for (const sk of orphans) clearStreamTimeout(sk);
    setStreaming(prev => { const next = { ...prev }; for (const sk of orphans) next[sk] = false; return next; });
    setLoading(prev => { const next = { ...prev }; for (const sk of orphans) next[sk] = false; return next; });
    setThinking(prev => { const next = { ...prev }; for (const sk of orphans) next[sk] = false; return next; });
    for (const sk of orphans) settleTurn(sk);
  }, [clearStreamTimeout, settleTurn]);

  const addMessage = useCallback((sessionKey: string, message: Omit<ChatMessage, 'id'> & { id?: string }, besideKey?: string) => {
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
      // Never into this window's own reply: the SSE fills it, and a row that
      // reaches it over the socket was written beside the turn.
      if (last && !localSSESessionsRef.current.has(sessionKey) && shouldAdoptIntoPlaceholder({
        incomingId: message.id,
        incomingRole: newMessage.role,
        last,
        streamingMessageId: streamMessageIdRef.current.get(sessionKey),
      })) {
        const updated = [...existing];
        updated[existing.length - 1] = { ...last, id: newMessage.id, content: newMessage.content, partial: false };
        return { ...prev, [sessionKey]: updated };
      }
      return { ...prev, [sessionKey]: insertBeside(existing, newMessage, besideKey) };
    });

    return newMessage;
  }, []);

  /**
   * A reload's snapshot, plus the rows a `message:new` added while this
   * window's own SSE held the session and the snapshot does not hold yet: it
   * replaces the whole thread, and was taken before they were written.
   */
  const withRowsArrivedDuringOwnSse = useCallback((sessionKey: string, held: ChatMessage[] | undefined, fetched: ChatMessage[]): ChatMessage[] => {
    const arrived = wsRowsDuringOwnSseRef.current.get(sessionKey);
    if (!arrived || !held) return fetched;
    const fetchedIds = new Set(fetched.map((m) => m.id));
    const younger = held.filter((m) => arrived.has(m.id) && !fetchedIds.has(m.id));
    return younger.length ? [...fetched, ...younger] : fetched;
  }, []);

  /** `addMessage` for a row another window or the server announced. */
  const addMessageFromWS = useCallback((sessionKey: string, message: Omit<ChatMessage, 'id'> & { id?: string }) => {
    if (message.id && localSSESessionsRef.current.has(sessionKey)) {
      const ids = wsRowsDuringOwnSseRef.current.get(sessionKey) ?? new Set<string>();
      ids.add(message.id);
      wsRowsDuringOwnSseRef.current.set(sessionKey, ids);
    }
    return addMessage(sessionKey, message, ownSendKeyRef.current.get(sessionKey));
  }, [addMessage]);

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

  const appendToLastMessage = useCallback((sessionKey: string, contentDelta?: string, thinkingDelta?: string, frame?: WSFrameRow) => {
    // Unpainted until a frame shows it: the end of the turn waits for that frame.
    if (contentDelta || thinkingDelta) textPaintGateRef.current.markCommitted(sessionKey);
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = frameTargetIndex(sessionMessages, streamMessageIdRef.current.get(sessionKey), frame);

      if (lastMessageIndex >= 0) {
        const updatedMessages = [...sessionMessages];
        const lastMsg = sessionMessages[lastMessageIndex];

        // A late answer's first words open their own block and paragraph under
        // the cut, as the server writes them.
        const lateStart = !!(frame?.lateStart && contentDelta);
        let nextBlocks = lastMsg.blocks;
        // Reasoning first: a frame that buffered both is a block that closed
        // before the answer opened, and the row goes above the text, where the
        // final message keeps it.
        if (thinkingDelta) nextBlocks = appendBlock(nextBlocks, { kind: 'thinking', text: thinkingDelta });
        if (contentDelta) {
          nextBlocks = lateStart
            ? [...(nextBlocks ?? []), { kind: 'text', text: contentDelta }]
            : appendBlock(nextBlocks, { kind: 'text', text: contentDelta });
        }

        // Create a new object without mutating the old state reference
        updatedMessages[lastMessageIndex] = {
          ...lastMsg,
          content: lateStart ? lateStartContent(lastMsg.content, contentDelta!)
            : contentDelta ? (lastMsg.content || '') + contentDelta : lastMsg.content,
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

  const addToolCallToLastMessage = useCallback((sessionKey: string, toolCall: ToolCall, frame?: WSFrameRow) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = frameTargetIndex(sessionMessages, streamMessageIdRef.current.get(sessionKey), frame);

      if (lastMessageIndex >= 0) {
        const updatedMessages = [...sessionMessages];
        const lastMsg = updatedMessages[lastMessageIndex];

        // Defensive dedup (mirror of server-side `addToolCallToLastMessage`).
        // Cumulative-snapshot providers (Claude CLI) re-announce the same
        // tool_use block multiple times; without the merge by id each
        // re-announcement would append a fresh duplicate entry, and only the
        // FIRST one would ever flip to 'success' when stream:tool_result
        // arrives. The new payload's args usually win, its status only when it
        // moves the row forward (`withToolAnnouncement`); a NEW row is born
        // with the facts WS brought before it (`heldToolFacts.ts`).
        updatedMessages[lastMessageIndex] = withAnnouncedToolCall(lastMsg, toolCall, heldToolFactsRef.current, sessionKey);

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
  // A closed turn's late answer waits for the same frame in a queue of its own:
  // it names its bubble, and it is not the live turn's text (liveTurn.ts).
  const lateDeltaQueueRef = useRef<LateDelta[]>([]);
  const liveDeltaRafRef = useRef<number | null>(null);

  const flushLiveDeltas = useCallback((sessionKey?: string) => {
    for (const late of takeLateDeltas(lateDeltaQueueRef.current, sessionKey)) {
      appendToLastMessage(late.sessionKey, late.kind === 'content' ? late.text : undefined, late.kind === 'thinking' ? late.text : undefined, late.frame);
    }
    const buf = liveDeltaBufferRef.current;
    const keys = sessionKey != null ? (buf.has(sessionKey) ? [sessionKey] : []) : [...buf.keys()];
    for (const k of keys) {
      const pending = buf.get(k);
      buf.delete(k);
      if (pending && (pending.content || pending.thinking)) {
        appendToLastMessage(k, pending.content || undefined, pending.thinking || undefined);
      }
    }
    if (buf.size === 0 && lateDeltaQueueRef.current.length === 0 && liveDeltaRafRef.current != null) {
      cancelAnimationFrame(liveDeltaRafRef.current);
      liveDeltaRafRef.current = null;
    }
  }, [appendToLastMessage]);

  const bufferLiveDelta = useCallback((sessionKey: string, contentDelta?: string, thinkingDelta?: string, late?: LateDelta['frame']) => {
    if (late) {
      queueLateDelta(lateDeltaQueueRef.current, { sessionKey, frame: late, kind: contentDelta ? 'content' : 'thinking', text: contentDelta || thinkingDelta || '' });
    } else {
      recordStreamText(sessionKey, `${contentDelta ?? ''}${thinkingDelta ?? ''}`);
      const buf = liveDeltaBufferRef.current;
      const entry = buf.get(sessionKey) ?? { content: '', thinking: '' };
      if (contentDelta) entry.content += contentDelta;
      if (thinkingDelta) entry.thinking += thinkingDelta;
      buf.set(sessionKey, entry);
    }
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
  // A frame for a row not born yet follows the panel held for it (`heldToolFacts.ts`).
  const applyToolPatch = useCallback((sessionKey: string, toolCallId: string, patch: (tc: ToolCall) => ToolCall) => {
    setMessages(prev => {
      const cur = prev[sessionKey] ?? [];
      const next = patchToolCallOrFollow(cur, heldToolFactsRef.current, sessionKey, toolCallId, patch);
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
        const cur = next[sk] ?? [];
        let msgs = cur;
        for (const [toolCallId, partialResult] of perTool) {
          msgs = patchToolCallOrFollow(msgs, heldToolFactsRef.current, sk, toolCallId, tc => withPartialResult(tc, partialResult));
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
    lateDeltaQueueRef.current.length = 0;
    if (toolUpdateRafRef.current != null) cancelAnimationFrame(toolUpdateRafRef.current);
    toolUpdateBufferRef.current.clear();
  }, []);

  /**
   * The model opened a reasoning block: reserve its row now, at the point of
   * the timeline where it started reasoning, so the end of the turn inserts
   * nothing over the text. The server sends this sign when the CLI opens the
   * block (its reasoning text only exists in the final message), and with the
   * block's first text on the native runtime.
   * Called by the WS frame (`stream:thinking_start`) and by the sender's own
   * SSE (`{ thinking: { open: true } }`). The text that came before goes in
   * first, or the row would land above it.
   */
  const reserveThinkingRow = useCallback((sessionKey: string) => {
    flushLiveDeltas(sessionKey);
    setThinking(prev => ({ ...prev, [sessionKey]: true }));
    setMessages(prev => {
      const list = prev[sessionKey] || [];
      const last = list[list.length - 1];
      if (!last || last.role !== 'assistant' || !last.partial || last.blocks?.[last.blocks.length - 1]?.kind === 'thinking') return prev;
      const next = list.slice();
      next[next.length - 1] = { ...last, blocks: [...(last.blocks ?? []), { kind: 'thinking', text: '' }] };
      return { ...prev, [sessionKey]: next };
    });
  }, [flushLiveDeltas]);
  const { onWSMessage, registerWSHandler } = useStreamEvents({ heldBehindEndRef, flushLiveDeltas, flushToolUpdates, localSSESessionsRef, ownReplyClosedRef, swallowedAfterReplyRef, endedDuringOwnSseRef, scheduleSSEFailsafe, textPaintGateRef, beginStreaming, resetStreamTimeout, streamMessageIdRef, liveDeltaBufferRef, reserveThinkingRow, bufferLiveDelta, pendingLateStartRef, relightSettledTurn, upsertMarker, addToolCallToLastMessage, applyToolPatch, bufferToolUpdate, heldToolFactsRef, updateLastMessage, clearStreamTimeout, turnEndsRef, dropEmptyTurn, discardedRowsRef, settleTurn, wsHandlersRef, setGatewayConnected, drainTurnQueueRef });
  const { sendMessage } = useSendPipeline({ isSendLocked, acquireSendLock, localSSESessionsRef, ownSendKeyRef, endedDuringOwnSseRef, streamMessageIdRef, abortControllersRef, setError, beginStreaming, addMessage, bufferLiveDelta, flushLiveDeltas, reserveThinkingRow, addToolCallToLastMessage, textPaintGateRef, updateLastMessage, ownReplyClosedRef, heldToolFactsRef, withRowsArrivedDuringOwnSse, hydratedSessionsRef, drainTurnQueueRef, setPendingQueue, releaseSendLock, clearSSEFailsafe, wsRowsDuringOwnSseRef, swallowedAfterReplyRef, resetStreamTimeout, lastHistoryFetchAtRef, loadHistoryRef });

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

  // `isSessionLoading`, `isSessionStreaming`, `isSessionThinking` and
  // `wasSessionStopped` are module constants: they read the flag store, and a
  // component that renders from one subscribes to its session
  // (`useSessionFlagValue`).

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
   *
   * `sendNow`: «Send now» on a queued message. The turn stops the same way,
   * but the sub-agents it delegated to keep working (SEND_NOW_STOP_CAUSE).
   */
  const stopSession = useCallback(async (sessionKey: string, opts?: StopSessionOptions): Promise<boolean> => {
    // PRIMA di tutto il resto: «ferma» vuol dire fermo. L'abort qui sotto fa
    // finire lo stream, e la fine di uno stream è ciò che fa partire la coda —
    // per questo il freno si alza per primo e in modo DUREVOLE (le altre
    // finestre vedono solo «lo stream è finito», e ripartirebbero a spedire).
    // Era il guasto più grosso della coda: premere «ferma» faceva PARTIRE il
    // messaggio successivo. La coda resta dov'è, visibile come bolle «da
    // inviare» nel trascritto: si corregge sul posto, si butta, riparte subito
    // con «invia subito» o scrivendo il messaggio dopo.
    // Named after the turn it stops, so that lifting it later lifts that Stop
    // for every window, whenever its close reaches them.
    const stopped = serverTurnOf(sessionKey);
    holdQueue(sessionKey, stopped && stopped.turnId > 0 ? { boot: stopped.boot, turnId: stopped.turnId } : undefined);
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
      const res = await chatApi.abort(sessionKey, proposeWipe, opts?.sendNow ? SEND_NOW_STOP_CAUSE : undefined);
      // `cleared` è l'unica parola che conta: il server ricontrolla sul DB e
      // vede anche le righe fuori dal ramo attivo, che qui non si vedono.
      // Assente (server vecchio, richiesta fallita) ⇒ non si butta niente.
      clearedByServer = proposeWipe && (res as { cleared?: boolean })?.cleared === true;
      // Only background work was running, and it is stopped: the provider
      // reports the empty task list and the attention frame that follows
      // takes the composer's Stop away (`useTopicBackgroundTasks`).
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
  const { loadHistory } = useHistoryLoader({ localSSESessionsRef, lastHistoryFetchAtRef, HISTORY_DEDUP_MS, inFlightHistoryRef, rereadHistoryRef, hydratedSessionsRef, setError, turnEndsRef, turnStartsRef, streamMessageIdRef, discardedRowsRef, flushLiveDeltas, setCompactionMarkers, setPendingQueue, beginStreaming, resetStreamTimeout, drainTurnQueueRef, setOrphanedSessions, loadHistoryRef });

  useEffect(() => { loadHistoryRef.current = loadHistory; }, [loadHistory]);
  const { editMessage, regenerateMessage, deleteMessage, switchBranch } = useBranchActions({ isSendLocked, acquireSendLock, localSSESessionsRef, abortControllersRef, setError, beginStreaming, withRowsArrivedDuringOwnSse, hydratedSessionsRef, addMessage, streamMessageIdRef, bufferLiveDelta, flushLiveDeltas, textPaintGateRef, updateLastMessage, drainTurnQueueRef, releaseSendLock, clearSSEFailsafe, wsRowsDuringOwnSseRef, loadHistoryRef });

  const appendMediaToLastAssistant = useCallback((sessionKey: string, mediaPaths: string[], mediaSizes?: Record<string, [number, number]>) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastAssistantIdx = sessionMessages.findLastIndex(m => m.role === 'assistant');
      if (lastAssistantIdx < 0) return prev;

      const updated = [...sessionMessages];
      updated[lastAssistantIdx] = {
        ...updated[lastAssistantIdx],
        media: [...(updated[lastAssistantIdx].media || []), ...mediaPaths],
        mediaSizes: mergeMediaSizes(updated[lastAssistantIdx].mediaSizes, mediaSizes),
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
    forgetStreamTokenRate(sessionKey);
    // And what the store knew about the thread's length: with no messages
    // here, "only the tail" and "the whole thread" both stop meaning anything.
    resetHistoryCompleteness(sessionKey);
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
  }, [forgetSessionCaches, pendingQueueRef]);
  const { drainQueue, retryExpired, dismissExpiredSession } = useQueueRetry({ drainingRef, isSendLocked, setExpiredMessages, setPendingQueue, sendMessageRef });

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
    loadHistory,
    appendMediaToLastAssistant,
    clearSession,
    addMessageFromWS, // For real-time sync across windows
    onWSMessage,
    registerWSHandler,
    drainQueue,
    expiredMessages,
    retryExpired,
    dismissExpiredSession,
    pendingQueueSize: pendingQueue.length,
    getStreamQueueSize: (sessionKey: string) => getTurnQueue(sessionKey).length,
    error,
    gatewayConnected,
    isSessionOrphaned: (sessionKey: string) => orphanedSessions.has(sessionKey),
    isOwnStream: (sessionKey: string) => localSSESessionsRef.current.has(sessionKey),
  };
}
