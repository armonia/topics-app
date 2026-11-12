import { useCallback, useEffect } from 'react';
import { apiErrorCode, chatApi } from '../lib/api';
import type { ChatMessage, ChatRequest, Message, ToolCall, WSFrameRow } from '../types';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { HISTORY_FETCH_ALL } from '../../../shared/history-paging';
import { carryWatchedLive } from '../components/Chat/turnFold';
import {
claimBatch as claimQueuedTurns,
decideDrain,
decideSend,
dropStoredTurns,
enqueueTurn,
getQueue as getTurnQueue,
isHeld as isQueueHeld,
liftedStop,
releaseClaim,
releaseHold,
unshiftTurn
} from '../state/chatQueue';
import {
markHistoryComplete
} from '../state/historyCompleteness';
import {
// Importata con l'alias storico: e' una funzione di MODULO, quindi stabile per
// definizione — ed e' anche il motivo per cui non compare in nessuna lista di
// dipendenze, mentre il vecchio `setMessages` di `useState` ci compariva.
updateMessages as setMessages
} from '../state/messageStore';
import { answerFromText, findPendingAsk } from '../state/pendingAsk';
import { armPushAsk } from '../state/pushAsk';
import { lastStopOf, noteServerTurn, openTurnRef, serverTurnOf, type TurnRef } from '../state/serverTurn';
import {
finishStreamTokenRate
} from '../state/streamTokenRate';
import { buildRequestMessages } from './chatRequestPayload';
import { CLAIM_CLIENT_ID, TURN_DRAIN_MAX_ATTEMPTS, TURN_DRAIN_RETRY_MS, batchSend, cleanInvisibleMarkers, generateMessageId, isContextMessage, messagesRef, queueStorage, setLoading, setStreaming, setThinking, withdrawWaitingBubble, type LoadHistoryOptions, type SendMessageOptions } from './chatShared';
import { HeldToolFacts } from './heldToolFacts';
import { LiveTurnIds, type LateDelta } from './liveTurn';
import {
OUTBOUND_QUEUE_KEY,
enqueue,
type QueuedMessage
} from './outboundQueue';
import { afterUnfinishedSend, namedByServer, placeOwnBubble } from './ownBubble';
import { toolCallFromSse, withSseToolResult, type SseToolCallDelta, type SseToolResultDelta } from './sseToolFrames';
import { TextPaintGate } from './textPaintGate';








export interface SendPipelineCtx {
  isSendLocked: (sk: string) => boolean;
  acquireSendLock: (sk: string) => Map<string, number>;
  localSSESessionsRef: React.RefObject<Set<string>>;
  ownSendKeyRef: React.RefObject<Map<string, string>>;
  endedDuringOwnSseRef: React.RefObject<Set<string>>;
  streamMessageIdRef: React.RefObject<LiveTurnIds>;
  abortControllersRef: React.RefObject<Record<string, AbortController>>;
  setError: (value: React.SetStateAction<Record<string, string | null>>) => void;
  beginStreaming: (sessionKey: string) => void;
  addMessage: (sessionKey: string, message: Omit<ChatMessage, "id"> & { id?: string; }, besideKey?: string) => ChatMessage;
  bufferLiveDelta: (sessionKey: string, contentDelta?: string, thinkingDelta?: string, late?: LateDelta["frame"]) => void;
  flushLiveDeltas: (sessionKey?: string) => void;
  reserveThinkingRow: (sessionKey: string) => void;
  addToolCallToLastMessage: (sessionKey: string, toolCall: ToolCall, frame?: WSFrameRow) => void;
  textPaintGateRef: React.RefObject<TextPaintGate>;
  updateLastMessage: (sessionKey: string, updates: Partial<ChatMessage>) => void;
  ownReplyClosedRef: React.RefObject<Set<string>>;
  heldToolFactsRef: React.RefObject<HeldToolFacts>;
  withRowsArrivedDuringOwnSse: (sessionKey: string, held: ChatMessage[] | undefined, fetched: ChatMessage[]) => ChatMessage[];
  hydratedSessionsRef: React.RefObject<Set<string>>;
  drainTurnQueueRef: React.RefObject<((sk: string, attempt?: number) => void) | null>;
  setPendingQueue: (value: React.SetStateAction<QueuedMessage[]>) => void;
  releaseSendLock: (sk: string) => boolean;
  clearSSEFailsafe: (sessionKey: string) => void;
  wsRowsDuringOwnSseRef: React.RefObject<Map<string, Set<string>>>;
  swallowedAfterReplyRef: React.RefObject<Set<string>>;
  resetStreamTimeout: (sessionKey: string) => void;
  lastHistoryFetchAtRef: React.RefObject<Map<string, number>>;
  loadHistoryRef: React.RefObject<((sk: string, opts?: LoadHistoryOptions) => Promise<boolean>) | null>;
}

export function useSendPipeline(ctx: SendPipelineCtx) {
  const { isSendLocked, acquireSendLock, localSSESessionsRef, ownSendKeyRef, endedDuringOwnSseRef, streamMessageIdRef, abortControllersRef, setError, beginStreaming, addMessage, bufferLiveDelta, flushLiveDeltas, reserveThinkingRow, addToolCallToLastMessage, textPaintGateRef, updateLastMessage, ownReplyClosedRef, heldToolFactsRef, withRowsArrivedDuringOwnSse, hydratedSessionsRef, drainTurnQueueRef, setPendingQueue, releaseSendLock, clearSSEFailsafe, wsRowsDuringOwnSseRef, swallowedAfterReplyRef, resetStreamTimeout, lastHistoryFetchAtRef, loadHistoryRef } = ctx;


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
  const performSend = useCallback(async (sessionKey: string, content: string, options?: SendMessageOptions, restoreOnFailure?: (waitsFor?: TurnRef, mayBeStored?: boolean) => void): Promise<boolean> => {
    if (isSendLocked(sessionKey)) {
      // Back where it came from when it came from the queue (same ids, same
      // attachments, same order); at the end of the queue when it did not.
      if (restoreOnFailure) restoreOnFailure();
      else enqueueTurn(sessionKey, content, options, openTurnRef(sessionKey));
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
    // The reply closed without [DONE] while the server still runs the turn (see the reload below).
    let liveAfterCut = false;
    // ...or the reload's snapshot says so, but the turn ended or was stopped while it was in flight.
    let staleSnapshot = false;
    // The server already holds this message (`duplicate_message`): read its row once the stream is released.
    let alreadyStored = false;
    // The empty reply bubble this send draws, found again by its id (`afterUnfinishedSend`).
    let placeholderId: string | undefined;
    localSSESessionsRef.current.add(sessionKey); // Block WS duplicates for this session
    ownSendKeyRef.current.set(sessionKey, idemKey);
    endedDuringOwnSseRef.current.delete(sessionKey);
    // Difesa in profondità: da qui parte un turno NUOVO, e il segnaposto lo conia
    // questa funzione con un id locale. Qualunque nome fosse rimasto appeso da un
    // turno precedente morto male è ormai il nome di una bolla morta, e le delta
    // di questo turno ci finirebbero dentro invece che nel segnaposto qui sotto.
    streamMessageIdRef.current.end(sessionKey);

    // Create AbortController for this session
    const abortController = new AbortController();
    abortControllersRef.current[sessionKey] = abortController;

    try {
      setError(prev => (prev[sessionKey] == null ? prev : { ...prev, [sessionKey]: null }));
      setLoading(prev => ({ ...prev, [sessionKey]: true }));

      // The person's bubble, named by this send's key. The row already there
      // for this message (a draft's first send, `userMessageId`; a resend from
      // the outbound queue, same key) takes it instead of a second bubble.
      setMessages(prev => ({ ...prev, [sessionKey]: placeOwnBubble(prev[sessionKey] ?? [], {
        id: options?.userMessageId ?? generateMessageId(), role: 'user', content, timestamp: new Date().toISOString(), clientMessageId: idemKey,
        ...(options?.mediaSizes ? { mediaSizes: options.mediaSizes } : {}),
      }, options?.userMessageId, options?.mayBeStored) }));

      // La coda, non tutto. Il ramo legato a una topic legge solo l'ultimo
      // elemento; quello senza topic usa `slice(0, -1)` come storia. Vedi
      // `chatRequestPayload.ts` per il perché di ciascuna delle due regole.
      const sessionMessages = messagesRef.current[sessionKey] || [];
      const apiMessages: Message[] = buildRequestMessages(sessionMessages, content);

      beginStreaming(sessionKey);

      // Create placeholder assistant message immediately for inline loading
      placeholderId = addMessage(sessionKey, {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        partial: true,
      }).id;
      // The reply's writers find it by this name (`LiveTurnIds`): a row
      // written beside the turn can be the last one now, and the text after it
      // went nowhere, or into that row.
      streamMessageIdRef.current.begin(sessionKey, placeholderId);

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
      let sawDone = false;

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
              sawDone = true;
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

              // The reasoning, on this reply's own SSE (the WS copies are
              // dropped for this window): the block's opening reserves the
              // row in its place, its text fills it, as in any other window.
              if (parsed.thinking?.open === true) {
                commitTextBefore();
                reserveThinkingRow(sessionKey);
              } else if (parsed.thinking?.open === false) {
                setThinking(prev => ({ ...prev, [sessionKey]: false }));
              }
              if (typeof delta?.thinking === 'string') thinkingBatch += delta.thinking;

              // Handle tool calls
              if (delta?.tool_calls) {
                commitTextBefore();
                for (const tc of delta.tool_calls as SseToolCallDelta[]) {
                  // The same ToolCall the WS frame carries: `startedAt` and `detail` included (CHAT-TOOL-10).
                  const toolCall = toolCallFromSse(tc, generateMessageId);
                  if (toolCall) addToolCallToLastMessage(sessionKey, toolCall);
                }
              }

              // Handle tool results — update BOTH the legacy `toolCalls`
              // bucket and the new `blocks` timeline. Replace the ToolCall
              // object with a new instance (not just mutate in place) so
              // React.memo on MessageContent sees a real prop change and
              // re-renders the row out of its "running" state.
              if (delta?.tool_result) {
                const toolResult = delta.tool_result as SseToolResultDelta;
                const trId = toolResult.id;
                if (trId) {
                  commitTextBefore();
                  setMessages(prev => {
                    const msgs = [...(prev[sessionKey] || [])];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                        const tcIdx = msgs[i].toolCalls!.findIndex(t => t.id === trId);
                        if (tcIdx >= 0) {
                          const oldTc = msgs[i].toolCalls![tcIdx];
                          // `endedAt`, `error` and `detail` too, as on the WS frame (CHAT-TOOL-10).
                          const newTc: ToolCall = withSseToolResult(oldTc, toolResult);
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
            // A reply that ends right behind its last word: those words are
            // drawn while the loader is still there, and the loader goes in a
            // later frame, where it moves nothing (`textPaintGate.ts`).
            if (textPaintGateRef.current.isPending(sessionKey)) await textPaintGateRef.current.painted(sessionKey);
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
        ownReplyClosedRef.current.add(sessionKey);
        // Whatever row never came on this reply comes with the history reload below.
        heldToolFactsRef.current.clear(sessionKey);
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
        setMessages(prev => {
          const next = withRowsArrivedDuringOwnSse(sessionKey, prev[sessionKey], chatMessages);
          // The reply this window just streamed, now under the server's id,
          // stays spread out as it was drawn (`carryWatchedLive`).
          carryWatchedLive(prev[sessionKey] ?? [], next);
          return { ...prev, [sessionKey]: next };
        });
        // Before the queue drains at the end of this send: what it holds already stored leaves it.
        dropStoredTurns(sessionKey, chatMessages);
        const finalAssistant = [...chatMessages].reverse().find((message) => message.role === 'assistant');
        // No [DONE], and the server still has the turn in flight: what ended is
        // the response (a proxy, an idle timeout), not the turn. It stays lit and
        // the WS frames take over, named after the row it is writing.
        // Not if the turn's end already came through the gate above while the
        // reload was in flight, or somebody pressed Stop: the snapshot predates
        // both, and relighting on it kept a Stop up for ~25 s on a finished turn
        // and brought a stopped one back.
        noteServerTurn(sessionKey, historyResponse.turn);
        const cutWhileLive = !sawDone && historyResponse.isStreaming === true;
        staleSnapshot = cutWhileLive && (endedDuringOwnSseRef.current.has(sessionKey) || isQueueHeld(sessionKey));
        liveAfterCut = cutWhileLive && !staleSnapshot;
        if (liveAfterCut && finalAssistant?.partial) streamMessageIdRef.current.begin(sessionKey, finalAssistant.id);
        else finishStreamTokenRate(sessionKey, finalAssistant?.usageCompletionTokens);
        hydratedSessionsRef.current.add(sessionKey);
        // The whole thread, in one answer: nothing is missing above it.
        markHistoryComplete(sessionKey);
      } catch {}

      // Turno concluso in casa (SSE locale): stessa regola dello `stream:end`
      // via WS — tocca alla coda, se non è stata messa in freno da uno stop.
      if (!liveAfterCut) drainTurnQueueRef.current?.(sessionKey);

      return true;
    } catch (err) {
      // What stays of this send in the thread, by its key and its
      // placeholder's id, never the last rows: a row written beside the send
      // while its POST was in flight sits after them, and may say the same words.
      const leave = (fate: 'withdraw' | 'queued' | 'keep' | 'stopped') => setMessages(prev => {
        const rows = prev[sessionKey] ?? [];
        const next = afterUnfinishedSend(rows, idemKey, placeholderId, fate);
        return next === rows ? prev : { ...prev, [sessionKey]: next };
      });
      // A person's Stop: the reply closes where it stands (`stopped`).
      if (err instanceof DOMException && err.name === 'AbortError') {
        leave('stopped');
        return true;
      }

      console.error('Failed to send message:', err);

      const is409 = !!err && typeof err === 'object' && 'status' in err && (err as { status?: unknown }).status === 409;
      // Read the `code`, never the text: the message is the sentence a person
      // reads, and the code travels beside it.
      const code = is409 ? apiErrorCode(err) : undefined;

      /**
       * TWO 409s THAT WANT OPPOSITE THINGS, AND ONLY TWO THAT RE-DECIDE THE SEND.
       *
       * `duplicate_message`: the server already holds this message under this
       * key. Re-queueing it would send it twice, the duplicate the key exists
       * to prevent: the bubbles go and the history is read once the stream is
       * released (`alreadyStored`, in `finally`; `loadHistory` skips a session
       * this send still holds, and the stored row never appeared).
       * `stream_in_flight`: refused BEFORE the row is written
       * (`server/routes/chat.ts`), so the message goes back to the HEAD of the
       * queue, its bubbles off the thread: the queue shows it as «to send».
       * Any other 409 (`topics_routing_incompatible` can come after the row
       * was written and announced) is an error the person reads, below.
       */
      if (code === 'duplicate_message') {
        leave('withdraw');
        alreadyStored = true;
        return true;
      }
      if (code === 'stream_in_flight') {
        leave('withdraw');
        // The refusal names the turn in flight: taken as the server's word, and
        // the message waits for THAT turn's end, not for this window's flag.
        const refusedBy = (err as { turn?: unknown }).turn;
        noteServerTurn(sessionKey, refusedBy);
        const waitsFor = openTurnRef(sessionKey);
        // The batch goes back as it was (its ids, its attachments, its order),
        // not merged into one new item under a new key.
        if (restoreOnFailure) restoreOnFailure(waitsFor);
        else unshiftTurn(sessionKey, content, options, waitsFor);
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
        // The bubble stays, marked queued: no banner, the per-message badge
        // already tells the right session, and a hook-wide string does not.
        leave('queued');
        return false;
      }

      // Every other failure. From the queue, this is the LAST place the
      // message still exists (`claimHead` took it off durable storage): it
      // goes back there, and only there, when the server did not take it (no
      // stream, no 409 about this very message, no row announced with its
      // key). Back in the queue AND on screen was two copies after the drain.
      const backToQueue = !streamStarted && !is409 && !!restoreOnFailure && !namedByServer(messagesRef.current[sessionKey] ?? [], idemKey);
      // The POST reached the server, which may have stored the row before
      // failing: the message goes back under its key, alone (`mayBeStored`).
      if (backToQueue) restoreOnFailure(undefined, true);

      setError(prev => ({ ...prev, [sessionKey]: err instanceof Error ? err.message : 'Failed to send message' }));
      leave(backToQueue ? 'withdraw' : 'keep');

      return false;
    } finally {
      releaseSendLock(sessionKey); // Release send lock
      clearSSEFailsafe(sessionKey); // lo stream è chiuso: niente abort in ritardo
      localSSESessionsRef.current.delete(sessionKey); // Re-enable WS events for this session
      wsRowsDuringOwnSseRef.current.delete(sessionKey);
      ownSendKeyRef.current.delete(sessionKey);
      ownReplyClosedRef.current.delete(sessionKey);
      const swallowedAfterReply = swallowedAfterReplyRef.current.delete(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
      // A name outliving its bubble makes the next turn write into it (`LiveTurnIds`).
      if (streamMessageIdRef.current.get(sessionKey) === placeholderId) streamMessageIdRef.current.end(sessionKey);
      if (liveAfterCut) {
        beginStreaming(sessionKey);
        resetStreamTimeout(sessionKey);
      }
      // The rows on screen are that snapshot: read them again now the SSE is gone,
      // past the dedup too. A pane opened under HISTORY_DEDUP_MS ago skipped the
      // read, and a turn started meanwhile from another window stayed dark.
      // The same after `duplicate_message`: the row is the server's, and only a read shows it.
      if (staleSnapshot || alreadyStored) {
        lastHistoryFetchAtRef.current.delete(sessionKey);
        // `fresh`: a read already in flight may predate the row; it is read again after it.
        void loadHistoryRef.current?.(sessionKey, alreadyStored ? { fresh: true } : undefined);
      } else if (liveAfterCut && swallowedAfterReply) {
        // A frame of the live turn came while the reload was in flight and the
        // gate dropped it: read again now that the socket's frames land, on a
        // snapshot taken after that frame. The turn stays lit meanwhile.
        void loadHistoryRef.current?.(sessionKey, { fresh: true, keepLit: true });
      }
    }
  }, [addMessage, addToolCallToLastMessage, updateLastMessage, bufferLiveDelta, flushLiveDeltas, clearSSEFailsafe, beginStreaming, resetStreamTimeout, withRowsArrivedDuringOwnSse, reserveThinkingRow, abortControllersRef, acquireSendLock, drainTurnQueueRef, endedDuringOwnSseRef, heldToolFactsRef, hydratedSessionsRef, isSendLocked, lastHistoryFetchAtRef, loadHistoryRef, localSSESessionsRef, ownReplyClosedRef, ownSendKeyRef, releaseSendLock, setError, setPendingQueue, streamMessageIdRef, swallowedAfterReplyRef, textPaintGateRef, wsRowsDuringOwnSseRef]);

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
   *      resta visibile nel trascritto e la decide lui;
   *   2. **occupato**: se un altro turno è in volo si riprova poco dopo, senza
   *      mai perdere l'item (che resta scritto su disco finché non è preso);
   *   3. **prenotazione**: la testa esce una volta sola anche con due finestre
   *      aperte sullo stesso topic.
   */
  const drainTurnQueue = useCallback((sessionKey: string, attempt = 0): void => {
    // The decision is `decideDrain`, pure and tested: the server's word on the
    // turn, never this window's `streaming` flag (see its header for the paths
    // that reset that flag in the middle of a turn).
    const queue = getTurnQueue(sessionKey);
    const stop = lastStopOf(sessionKey);
    const verdict = decideDrain({
      held: isQueueHeld(sessionKey),
      queued: queue.length,
      sendLocked: isSendLocked(sessionKey),
      serverTurn: serverTurnOf(sessionKey),
      head: queue[0],
      pendingAsk: !!findPendingAsk(messagesRef.current[sessionKey]),
      stop,
      lifted: liftedStop(sessionKey),
    });
    // A Stop this queue was written before: the durable hold was raised when
    // the Stop was heard (`noteStop`); a head another window wrote without
    // having heard it yet waits here, and that window holds it when it hears.
    if (verdict === 'hold-stop') return;
    if (verdict === 'wait-own-send') {
      if (attempt >= TURN_DRAIN_MAX_ATTEMPTS) return;
      setTimeout(() => drainTurnQueueRef.current?.(sessionKey, attempt + 1), TURN_DRAIN_RETRY_MS);
      return;
    }
    // `wait-turn`: the `turn:state` that closes it calls again. `hold`: the person decides.
    if (verdict !== 'drain') return;
    const batch = claimQueuedTurns(sessionKey, CLAIM_CLIENT_ID);
    if (batch.length === 0) return;
    // The head's id is the idempotency key: two windows that both won the claim
    // send the same key, and the server takes the batch once (`duplicate_message`).
    const send = batchSend(sessionKey, batch);
    void performSend(sessionKey, send.content, send.options, send.restore)
      .finally(() => releaseClaim(sessionKey, CLAIM_CLIENT_ID));
  }, [performSend, drainTurnQueueRef, isSendLocked]);
  // In un effetto, non in fase di render, come il gemello `sendMessageRef` qui
  // sotto: scrivere un ref durante il render lo fa puntare alla closure di un
  // render che potrebbe non essere mai committato (StrictMode ne fa due, e uno
  // concorrente si può buttare via).
  useEffect(() => { drainTurnQueueRef.current = drainTurnQueue; }, [drainTurnQueue, drainTurnQueueRef]);

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
          setError(prev => ({ ...prev, [sessionKey]: `Risposta non consegnata: ${msg}` }));
          return false;
        }
      }
    }

    // Busy = this window's own send still streaming, or the server's ledger has
    // a turn open (a turn the CLI opened by itself included). The message then
    // waits for THAT turn: `waitsFor`, shared with every window.
    const waitsFor = openTurnRef(sessionKey);
    const busy = isSendLocked(sessionKey) || !!waitsFor;
    const decision = decideSend({ busy, queued: getTurnQueue(sessionKey).length });

    if (decision === 'queue') {
      // The person writing again is the person's own send: it lifts a Stop's
      // hold, and what was held leaves with this message at the end of the
      // turn. Without this, a message typed right after a Stop, while the
      // stopped turn had not closed yet, waited behind the hold for good:
      // the close found the queue held, and nothing else asks again.
      if (content.trim()) releaseHold(sessionKey);
      enqueueTurn(sessionKey, content, options, waitsFor);
      withdrawWaitingBubble(sessionKey, options?.clientMessageId);
      return true;
    }

    if (decision === 'queue-then-drain') {
      // C'era già una coda ferma (tipico dopo uno stop): questo messaggio va in
      // FONDO e riparte dalla testa, altrimenti scavalcherebbe quello che
      // l'umano aveva scritto prima. Parte tutta la coda in un turno solo — il
      // nuovo messaggio compreso, se le opzioni combaciano.
      enqueueTurn(sessionKey, content, options);
      withdrawWaitingBubble(sessionKey, options?.clientMessageId);
      const batch = claimQueuedTurns(sessionKey, CLAIM_CLIENT_ID);
      if (batch.length === 0) return true;
      const send = batchSend(sessionKey, batch);
      return performSend(sessionKey, send.content, send.options, send.restore)
        .finally(() => releaseClaim(sessionKey, CLAIM_CLIENT_ID));
    }

    return performSend(sessionKey, content, options);
  }, [performSend, isSendLocked, setError]);

  return { sendMessage };
}
