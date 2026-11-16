import { useCallback, useEffect, useRef } from 'react';
import { chatApi } from '../lib/api';
import type { ChatMessage, CompactionMarker } from '../types';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { HISTORY_FETCH_ALL, HISTORY_FIRST_PAGE } from '../../../shared/history-paging';
import { carryWatchedLive } from '../components/Chat/turnFold';
import {
dropStoredTurns
} from '../state/chatQueue';
import {
getHistoryCompleteness,
markHistoryComplete,
markHistoryPartial,
markHistoryStaged,
registerHistoryCompleter,
type HistoryCompletionMode
} from '../state/historyCompleteness';
import { clearHistoryFromCache, markHistoryFromCache } from '../state/historyFromCache';
import { settleLocalCopyRows, showsLocalCopyRows } from '../state/localCopyRows';
import {
// Importata con l'alias storico: e' una funzione di MODULO, quindi stabile per
// definizione — ed e' anche il motivo per cui non compare in nessuna lista di
// dipendenze, mentre il vecchio `setMessages` di `useState` ci compariva.
updateMessages as setMessages
} from '../state/messageStore';
import { noteServerTurn } from '../state/serverTurn';
import { cacheMessages, getCachedMessages } from './chatMessageCache';
import { cleanInvisibleMarkers, generateMessageId, getOutboundQueue, isContextMessage, messagesRef, queueStorage, setLoading, setStreaming, setThinking, type LoadHistoryOptions } from './chatShared';
import { mergeHistoryPage, mergeOlderHistory, pageOverlapsExisting, rowsAboveLocalCopy } from './historyPaging';
import { LiveTurnIds } from './liveTurn';
import {
OUTBOUND_QUEUE_KEY,
removeSession as removeQueueSession,
type QueuedMessage
} from './outboundQueue';
import { mergeFetchedHistory, reconcileMessages } from './reconcileMessages';







export interface HistoryLoaderCtx {
  localSSESessionsRef: React.RefObject<Set<string>>;
  lastHistoryFetchAtRef: React.RefObject<Map<string, number>>;
  HISTORY_DEDUP_MS: 5000;
  inFlightHistoryRef: React.RefObject<Set<string>>;
  rereadHistoryRef: React.RefObject<Map<string, LoadHistoryOptions>>;
  hydratedSessionsRef: React.RefObject<Set<string>>;
  setError: (value: React.SetStateAction<Record<string, string | null>>) => void;
  turnEndsRef: React.RefObject<Map<string, number>>;
  turnStartsRef: React.RefObject<Map<string, number>>;
  streamMessageIdRef: React.RefObject<LiveTurnIds>;
  discardedRowsRef: React.RefObject<Map<string, Set<string>>>;
  flushLiveDeltas: (sessionKey?: string) => void;
  setCompactionMarkers: (value: React.SetStateAction<Record<string, CompactionMarker[]>>) => void;
  setPendingQueue: (value: React.SetStateAction<QueuedMessage[]>) => void;
  beginStreaming: (sessionKey: string) => void;
  resetStreamTimeout: (sessionKey: string) => void;
  drainTurnQueueRef: React.RefObject<((sk: string, attempt?: number) => void) | null>;
  setOrphanedSessions: (value: React.SetStateAction<Set<string>>) => void;
  loadHistoryRef: React.RefObject<((sk: string, opts?: LoadHistoryOptions) => Promise<boolean>) | null>;
}

export function useHistoryLoader(ctx: HistoryLoaderCtx) {
  const { localSSESessionsRef, lastHistoryFetchAtRef, HISTORY_DEDUP_MS, inFlightHistoryRef, rereadHistoryRef, hydratedSessionsRef, setError, turnEndsRef, turnStartsRef, streamMessageIdRef, discardedRowsRef, flushLiveDeltas, setCompactionMarkers, setPendingQueue, beginStreaming, resetStreamTimeout, drainTurnQueueRef, setOrphanedSessions, loadHistoryRef } = ctx;


  /**
   * The second request of a tail-first open: everything BEFORE the first page,
   * in two steps that the caller may take apart.
   *
   * Never fired on its own by this hook. `MessageList` asks for it when its
   * pane is hidden (`decideHistoryCompletion`) or when the reader clicks the
   * row at the top of the loaded window, and any surface that needs the whole
   * thread asks through `requestHistoryCompletion`. It never touches `loading`
   * - the curtain is already up and a skeleton over a chat you are reading is
   * the one thing this must not do - and merges around the boundary id so the
   * rows the pane holds are not reordered (`mergeOlderHistory`).
   *
   * `stage` FETCHES AND HOLDS: the rows land in `historyCompleteness`, not in
   * the list. The hidden pane that asked may be on screen again by the time
   * the answer arrives (0.7-1.7 s on a big chat), and merging then would
   * re-index the rows under the reader's eyes. `apply` merges - the staged
   * rows if they are here, otherwise it fetches first. An `apply` arriving
   * while a `stage` is in flight upgrades it: the answer is merged on arrival.
   *
   * One request per session at a time; on failure the session simply stays
   * partial and the next ask fetches again.
   */
  const olderInFlightRef = useRef<Map<string, { run: Promise<void>; apply: boolean }>>(new Map());
  const applyOlderHistory = useCallback((sessionKey: string, older: ChatMessage[], boundaryId: string) => {
    setMessages(prev => {
      const existing = prev[sessionKey] || [];
      const merged = mergeOlderHistory(existing, older, boundaryId);
      if (merged === existing) return prev;
      return { ...prev, [sessionKey]: reconcileMessages(existing, merged) };
    });
    // Still the same open: a whole-thread reload in the meantime has already
    // marked the session, and a newer partial one has its own boundary.
    const now = getHistoryCompleteness(sessionKey);
    if ((now.state === 'partial' || now.state === 'staged') && now.boundaryId === boundaryId) {
      markHistoryComplete(sessionKey);
    }
  }, []);
  const completeHistory = useCallback((sessionKey: string, mode: HistoryCompletionMode): Promise<void> => {
    const known = getHistoryCompleteness(sessionKey);
    if (known.state === 'staged') {
      if (mode === 'apply') applyOlderHistory(sessionKey, known.rows, known.boundaryId);
      return Promise.resolve();
    }
    if (known.state !== 'partial') return Promise.resolve();
    const inFlight = olderInFlightRef.current.get(sessionKey);
    if (inFlight) {
      if (mode === 'apply') inFlight.apply = true;
      return inFlight.run;
    }
    const boundaryId = known.boundaryId;
    const entry = { apply: mode === 'apply', run: Promise.resolve() };
    entry.run = (async () => {
      try {
        const response = await chatApi.getHistory(sessionKey, { limit: HISTORY_FETCH_ALL, before: boundaryId });
        const older: ChatMessage[] = response.messages
          .filter(msg => !isContextMessage(msg.content))
          .map(msg => ({
            ...msg,
            id: msg.id || generateMessageId(),
            content: cleanInvisibleMarkers(msg.content || ''),
            timestamp: msg.timestamp || new Date().toISOString(),
          }));
        if (entry.apply) applyOlderHistory(sessionKey, older, boundaryId);
        else markHistoryStaged(sessionKey, boundaryId, older);
      } catch (err) {
        console.warn('[useChat] the messages before the first page did not arrive; the chat stays on its tail until the next request', { sessionKey, err });
      } finally {
        olderInFlightRef.current.delete(sessionKey);
      }
    })();
    olderInFlightRef.current.set(sessionKey, entry);
    return entry.run;
  }, [applyOlderHistory]);
  useEffect(() => registerHistoryCompleter(completeHistory), [completeHistory]);

  const loadHistory = useCallback(async (sessionKey: string, opts?: LoadHistoryOptions): Promise<boolean> => {
    // Skip entirely if sendMessage is actively streaming via SSE — it owns the state
    if (localSSESessionsRef.current.has(sessionKey)) return true;

    // Dedup rapid re-fetches: a tab switch in StandaloneChatGroup re-mounts
    // ChatPane, whose mount effect calls loadHistory. A read of this session a
    // few seconds ago, with messages cached, is enough: WS keeps them fresh in
    // between. Not for a `fresh` read: rows changed with no frame to carry
    // them, and at boot every window has just read on reconnect (card edf3c4db).
    const lastFetchedAt = opts?.fresh ? undefined : lastHistoryFetchAtRef.current.get(sessionKey);
    if (lastFetchedAt && Date.now() - lastFetchedAt < HISTORY_DEDUP_MS && messagesRef.current[sessionKey]?.length) return true;

    // Collapse concurrent callers onto the in-flight request; a `fresh` one is
    // read again after it, since that read may predate the change.
    if (opts?.fresh && inFlightHistoryRef.current.has(sessionKey)) {
      const queued = rereadHistoryRef.current.get(sessionKey);
      rereadHistoryRef.current.set(sessionKey, { fresh: true, keepLit: !!(queued?.keepLit || opts.keepLit) });
    }
    if (inFlightHistoryRef.current.has(sessionKey)) return true;
    inFlightHistoryRef.current.add(sessionKey);
    let endedMeanwhile = false;
    // A thread this page already read from the server, and whose rows the
    // socket has kept current since (an open tab stays subscribed while its
    // body is unmounted; a chat inside a project window still gets every
    // `message:new` and `stream:end`), is refreshed in the background: the
    // read does not raise `loading`.
    // Raising it held the list's curtain (MessageList `listSettled`) until the
    // answer came, so a chat pane remounted by a tab switch (a body evicted by
    // the residency cap, a switch of Spazio) drew the skeleton for 10-12 frames
    // over rows that were already in the store (tab-switch audit 2026-09-29,
    // PERF-02). The first read of a session still raises it: there the rows on
    // screen are at most the device's local copy.
    const revalidate = hydratedSessionsRef.current.has(sessionKey) && (messagesRef.current[sessionKey]?.length ?? 0) > 0;

    try {
      setError(prev => (prev[sessionKey] == null ? prev : { ...prev, [sessionKey]: null }));
      if (!revalidate) setLoading(prev => ({ ...prev, [sessionKey]: true }));
      // Clear stale streaming/thinking state before server confirms the real state.
      // Not on a read of a turn this window knows is live: its Stop would blink
      // off for the length of the request.
      if (!opts?.keepLit) {
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
      }
      
      // The TAIL first. The whole thread used to come in one answer, and the
      // curtain waited for it: 500-1200 ms of skeleton on the desktop's own
      // chats (200 KB-2.6 MB each). A page of the last HISTORY_FIRST_PAGE rows
      // answers in tens of milliseconds; the rest is fetched by
      // `completeHistory`, only while nobody is looking at the list.
      const endsBefore = turnEndsRef.current.get(sessionKey) ?? 0;
      const startsBefore = turnStartsRef.current.get(sessionKey) ?? 0;
      const response = await chatApi.getHistory(sessionKey, { limit: HISTORY_FIRST_PAGE });
      // A turn ended while this answer was in flight: it describes that turn
      // as still running, and brought the spinner back for good. Its rows are
      // merged under the closed bubble (`mergeFetchedHistory`), and the history
      // is read again once this request is out of the way.
      endedMeanwhile = (turnEndsRef.current.get(sessionKey) ?? 0) !== endsBefore;
      const startedMeanwhile = (turnStartsRef.current.get(sessionKey) ?? 0) !== startsBefore;
      // The live row the answer may not hold yet, only while a turn is really
      // in flight: the name left by a turn whose end never reached this window
      // kept its deleted row as a bubble with a spinner.
      const liveRowId = response.isStreaming || startedMeanwhile ? streamMessageIdRef.current.get(sessionKey) : undefined;
      // While the store holds the local copy the list may already be showing
      // it (MessageList does not wait for this answer): rows of the page ABOVE
      // the copy stay out, as partial history (`rowsAboveLocalCopy`).
      const above = showsLocalCopyRows(sessionKey) ? rowsAboveLocalCopy(messagesRef.current[sessionKey] || [], response.messages) : 0;
      const pageRows = above > 0 ? response.messages.slice(above) : response.messages;
      // Fewer rows than the thread has: what came is a page, not the story.
      // Compared BEFORE the context-message filter below, which is client-side
      // and would otherwise make a complete thread look short.
      const total = response.total ?? response.messages.length;
      const wholeThread = pageRows.length >= total;
      const boundaryId = wholeThread ? null : (pageRows[0]?.id ?? null);

      const discarded = discardedRowsRef.current.get(sessionKey);
      // An answer read after the deletes no longer has those rows: the list
      // has done its job. One read before them still does, and drops them here.
      if (!endedMeanwhile) discardedRowsRef.current.delete(sessionKey);
      const chatMessages: ChatMessage[] = pageRows
        .filter(msg => !isContextMessage(msg.content) && !(msg.id && discarded?.has(msg.id)))
        .map(msg => ({
          ...msg,
          id: msg.id || generateMessageId(),
          content: cleanInvisibleMarkers(msg.content || ''),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      // A page over a thread this page already holds WHOLE (a reconnect, a
      // remount past the dedup window) is a refresh of its tail, not a new
      // partial open: everything before the page is already in the store.
      const alreadyWhole =
        getHistoryCompleteness(sessionKey).state === 'complete' &&
        pageOverlapsExisting(messagesRef.current[sessionKey] || [], chatMessages);

      // Merge with any messages that arrived via WS during the fetch (cross-window
      // sync race). Server history is the source of truth; we additively keep
      // local-only messages whose id isn't in the fetched set. A PAGE merges
      // around its pivot instead, so the local copy's rows older than the page
      // keep their place at the front (`mergeHistoryPage`).
      // Chunks still buffered for the next frame go in first: a snapshot that
      // already holds them would get them appended again when the frame comes.
      flushLiveDeltas(sessionKey);
      setMessages(prev => {
        const existing = prev[sessionKey] || [];
        const merge = wholeThread ? mergeFetchedHistory : mergeHistoryPage;
        const merged = merge(existing, chatMessages, { endedMeanwhile, liveRowId });
        // La storia che arriva è quasi sempre quella che è già a schermo: se lo
        // è, questa riga restituisce l'array PRECEDENTE e React salta il render
        // — niente ri-misura delle altezze, niente lista che si ri-assembla
        // sotto gli occhi un secondo dopo il ricarico. Vedi reconcileMessages.
        const riconciliato = reconcileMessages(existing, merged);
        if (riconciliato === existing) return prev;
        // The reply this window streamed keeps its spread-out shape under
        // the server's id (`carryWatchedLive`).
        carryWatchedLive(existing, riconciliato);
        return { ...prev, [sessionKey]: riconciliato };
      });
      if (boundaryId && !alreadyWhole) {
        markHistoryPartial(sessionKey, { boundaryId, missing: total - pageRows.length });
      } else {
        markHistoryComplete(sessionKey);
      }

      // Compaction dividers (CHAT-COMPACT-01) — replace the session's set with
      // the server's authoritative list on every history load.
      const markers = (response as { compactionMarkers?: CompactionMarker[] }).compactionMarkers;
      if (Array.isArray(markers)) {
        setCompactionMarkers(prev => ({ ...prev, [sessionKey]: markers }));
      }

      // Cache messages for offline fallback
      cacheMessages(sessionKey, chatMessages);
      // The server answered: whatever the pane was saying about the local copy
      // stops being true here (see `state/historyFromCache.ts`).
      clearHistoryFromCache(sessionKey);
      settleLocalCopyRows(sessionKey);
      // Mark this session as freshly loaded — subsequent re-mounts within
      // HISTORY_DEDUP_MS will short-circuit instead of re-fetching. Not an
      // answer older than a turn end: the read again must not be skipped.
      if (!endedMeanwhile) lastHistoryFetchAtRef.current.set(sessionKey, Date.now());
      // The local messages map for this session is now backed by the
      // server's authoritative response; `stopSession` may rely on its
      // count to decide whether this is a brand-new chat that can be
      // wiped. Until this point a Stop click MUST refuse to wipe.
      hydratedSessionsRef.current.add(sessionKey);
      // A queued message this read shows stored under its key leaves the queue
      // before the drain below can resend it (`QueuedTurn.sent`).
      dropStoredTurns(sessionKey, chatMessages);

      // Clear any queued outbound messages for this session — the server already has them
      const queue = getOutboundQueue();
      if (queue.some(q => q.sessionKey === sessionKey)) {
        setPendingQueue(removeQueueSession(queueStorage, OUTBOUND_QUEUE_KEY, sessionKey));
      }

      noteServerTurn(sessionKey, response.turn);
      // Restore streaming state from server (for cross-device sync)
      if (endedMeanwhile) {
        // Neither lit nor drained: the answer is older than the end.
      } else if (response.isStreaming) {
        beginStreaming(sessionKey);
        if (response.streamState?.isThinking) {
          setThinking(prev => ({ ...prev, [sessionKey]: true }));
        }
        // Reset the stream timeout since we just reconnected
        resetStreamTimeout(sessionKey);
      } else {
        // The server says nothing is in flight: a turn queued before a reload
        // waits for a `stream:end` this client never saw, and the turn it
        // closed keeps its row's name, unless a turn was lit meanwhile. Fires
        // once per hydrate (HISTORY_DEDUP_MS short-circuits remounts).
        if (opts?.keepLit) {
          setStreaming(prev => ({ ...prev, [sessionKey]: false }));
          setThinking(prev => ({ ...prev, [sessionKey]: false }));
        }
        if (!startedMeanwhile) streamMessageIdRef.current.end(sessionKey);
        drainTurnQueueRef.current?.(sessionKey);
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
      // Serve cached messages instead of an error banner when there are any:
      // the banner was firing on every transient load failure (e.g. the first
      // request racing with WS connect on initial page mount), and a red line
      // over rows that are perfectly readable is the wrong size of alarm.
      //
      // SILENTLY, THOUGH, IS WHAT IT USED TO BE, and that is the half that was
      // wrong: the rows on screen were the ones the server had answered LAST
      // TIME, presented exactly like rows fetched a second ago. The flag is
      // raised here and read by the pane (`state/historyFromCache.ts`), which
      // draws one discreet line with a way to ask again. The error is still
      // reserved for the case with nothing at all to show.
      const cached = getCachedMessages(sessionKey);
      if (cached && cached.length > 0) {
        setMessages(prev => ({ ...prev, [sessionKey]: cached }));
        markHistoryFromCache(sessionKey);
      } else {
        const existing = messagesRef.current[sessionKey];
        if (existing && existing.length > 0) {
          markHistoryFromCache(sessionKey);
        } else {
          // Genuinely empty state — show the error so the user knows
          // something is wrong.
          setError(prev => ({ ...prev, [sessionKey]: err instanceof Error ? err.message : 'Failed to load history' }));
        }
      }
      return false;
    } finally {
      inFlightHistoryRef.current.delete(sessionKey);
      if (!revalidate) setLoading(prev => ({ ...prev, [sessionKey]: false }));
      const reread = rereadHistoryRef.current.get(sessionKey);
      if (reread) {
        rereadHistoryRef.current.delete(sessionKey);
        void loadHistoryRef.current?.(sessionKey, reread);
      } else if (endedMeanwhile) void loadHistoryRef.current?.(sessionKey);
    }
  }, [resetStreamTimeout, beginStreaming, flushLiveDeltas, HISTORY_DEDUP_MS, discardedRowsRef, drainTurnQueueRef, hydratedSessionsRef, inFlightHistoryRef, lastHistoryFetchAtRef, loadHistoryRef, localSSESessionsRef, rereadHistoryRef, setCompactionMarkers, setError, setOrphanedSessions, setPendingQueue, streamMessageIdRef, turnEndsRef, turnStartsRef]);

  return { loadHistory };
}
