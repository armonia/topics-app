import { useCallback } from 'react';
import { chatApi } from '../lib/api';
import type { ChatMessage, HistoryMessage } from '../types';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { HISTORY_FETCH_ALL } from '../../../shared/history-paging';
import { carryWatchedLive } from '../components/Chat/turnFold';
import {
releaseHold
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
import {
finishStreamTokenRate
} from '../state/streamTokenRate';
import { cacheMessages } from './chatMessageCache';
import { cleanInvisibleMarkers, generateMessageId, isContextMessage, setLoading, setStreaming, setThinking, type LoadHistoryOptions } from './chatShared';
import { LiveTurnIds, type LateDelta } from './liveTurn';
import { afterUnfinishedSend } from './ownBubble';
import { TextPaintGate } from './textPaintGate';






export interface BranchActionsCtx {
  isSendLocked: (sk: string) => boolean;
  acquireSendLock: (sk: string) => Map<string, number>;
  localSSESessionsRef: React.RefObject<Set<string>>;
  abortControllersRef: React.RefObject<Record<string, AbortController>>;
  setError: (value: React.SetStateAction<Record<string, string | null>>) => void;
  beginStreaming: (sessionKey: string) => void;
  withRowsArrivedDuringOwnSse: (sessionKey: string, held: ChatMessage[] | undefined, fetched: ChatMessage[]) => ChatMessage[];
  hydratedSessionsRef: React.RefObject<Set<string>>;
  addMessage: (sessionKey: string, message: Omit<ChatMessage, "id"> & { id?: string; }, besideKey?: string) => ChatMessage;
  streamMessageIdRef: React.RefObject<LiveTurnIds>;
  bufferLiveDelta: (sessionKey: string, contentDelta?: string, thinkingDelta?: string, late?: LateDelta["frame"]) => void;
  flushLiveDeltas: (sessionKey?: string) => void;
  textPaintGateRef: React.RefObject<TextPaintGate>;
  updateLastMessage: (sessionKey: string, updates: Partial<ChatMessage>) => void;
  drainTurnQueueRef: React.RefObject<((sk: string, attempt?: number) => void) | null>;
  releaseSendLock: (sk: string) => boolean;
  clearSSEFailsafe: (sessionKey: string) => void;
  wsRowsDuringOwnSseRef: React.RefObject<Map<string, Set<string>>>;
  loadHistoryRef: React.RefObject<((sk: string, opts?: LoadHistoryOptions) => Promise<boolean>) | null>;
}

export function useBranchActions(ctx: BranchActionsCtx) {
  const { isSendLocked, acquireSendLock, localSSESessionsRef, abortControllersRef, setError, beginStreaming, withRowsArrivedDuringOwnSse, hydratedSessionsRef, addMessage, streamMessageIdRef, bufferLiveDelta, flushLiveDeltas, textPaintGateRef, updateLastMessage, drainTurnQueueRef, releaseSendLock, clearSSEFailsafe, wsRowsDuringOwnSseRef, loadHistoryRef } = ctx;


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
    // The new answer's bubble, and whether the branch reached its end (the
    // thread is read again once the session is released, `finally`).
    let placeholderId: string | undefined;
    let streamed = false;

    try {
      setError(prev => (prev[sessionKey] == null ? prev : { ...prev, [sessionKey]: null }));
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

      // Like the reload at the end of a send: a row written beside the turn
      // that reached this window over the socket while the snapshot was in
      // flight stays.
      setMessages(prev => {
        const next = withRowsArrivedDuringOwnSse(sessionKey, prev[sessionKey], chatMessages);
        carryWatchedLive(prev[sessionKey] ?? [], next);
        return { ...prev, [sessionKey]: next };
      });
      const finalAssistant = [...chatMessages].reverse().find((message) => message.role === 'assistant');
      finishStreamTokenRate(sessionKey, finalAssistant?.usageCompletionTokens);
      hydratedSessionsRef.current.add(sessionKey);
      markHistoryComplete(sessionKey);

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

      // Add a placeholder partial assistant message, named for its writers as
      // `performSend` names its own: a row arriving beside the branch can be
      // the last one, and the answer after it went nowhere.
      placeholderId = addMessage(sessionKey, {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        partial: true,
      }).id;
      streamMessageIdRef.current.begin(sessionKey, placeholderId);

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

            let parsed: { choices?: Array<{ delta?: { content?: string } }> } | null;
            try {
              parsed = JSON.parse(data);
            } catch (e) {
              // Not every `data:` line is a content frame (keepalives and
              // comments share the wire), but a line that LOOKS like JSON and
              // fails to parse drops a real chunk of the answer with no trace,
              // so it is worth seeing rather than silently skipped.
              console.warn('[useChat] SSE data line failed to parse, skipping', e);
              continue;
            }
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) {
              let chunk = delta.content;
              if (chunk.includes('<thinking>')) { isInThinking = true; setThinking(prev => ({ ...prev, [sessionKey]: true })); chunk = chunk.replace('<thinking>', ''); }
              if (chunk.includes('</thinking>')) { isInThinking = false; setThinking(prev => ({ ...prev, [sessionKey]: false })); chunk = chunk.replace('</thinking>', ''); }
              if (!isInThinking) chunk = cleanInvisibleMarkers(chunk);
              if (isInThinking) { thinkingBatch += chunk; }
              else if (chunk) { contentBatch += chunk; }
            }
          }

          // Same coalescing as the sendMessage reader above — this branch has no
          // tool calls or tool results, so there is no `blocks` timeline to keep
          // ordered and the buffer can simply absorb every cycle.
          if (contentBatch || thinkingBatch) {
            bufferLiveDelta(sessionKey, contentBatch || undefined, thinkingBatch || undefined);
          }
          if (isDone) {
            flushLiveDeltas(sessionKey); // `partial:false` must not race the last token
            // The last words on screen before the loader goes (`textPaintGate.ts`).
            if (textPaintGateRef.current.isPending(sessionKey)) await textPaintGateRef.current.painted(sessionKey);
            updateLastMessage(sessionKey, { partial: false });
          }
        }
      } finally {
        flushLiveDeltas(sessionKey);
        reader.releaseLock();
      }

      // The full history, for accurate sibling counts, is read in `finally`:
      // here the session is still this stream's and `loadHistory` skipped it.
      streamed = true;
      // Anche questo è un turno che finisce: se qualcuno ha scritto mentre la
      // risposta si rigenerava, adesso tocca a lui.
      drainTurnQueueRef.current?.(sessionKey);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // A Stop: the answer closes where it stands, by its id (`stopped`).
        setMessages(prev => ({ ...prev, [sessionKey]: afterUnfinishedSend(prev[sessionKey] ?? [], undefined, placeholderId, 'stopped') }));
        return true;
      }
      console.error(`Failed to ${label}:`, err);
      setError(prev => ({ ...prev, [sessionKey]: err instanceof Error ? err.message : `Failed to ${label}` }));
      return false;
    } finally {
      releaseSendLock(sessionKey); // Release send lock
      clearSSEFailsafe(sessionKey); // lo stream è chiuso: niente abort in ritardo
      localSSESessionsRef.current.delete(sessionKey);
      wsRowsDuringOwnSseRef.current.delete(sessionKey);
      if (streamMessageIdRef.current.get(sessionKey) === placeholderId) streamMessageIdRef.current.end(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
      if (streamed) void loadHistoryRef.current?.(sessionKey, { fresh: true });
    }
  }, [addMessage, updateLastMessage, bufferLiveDelta, flushLiveDeltas, clearSSEFailsafe, beginStreaming, withRowsArrivedDuringOwnSse, abortControllersRef, acquireSendLock, drainTurnQueueRef, hydratedSessionsRef, isSendLocked, loadHistoryRef, localSSESessionsRef, releaseSendLock, setError, streamMessageIdRef, textPaintGateRef, wsRowsDuringOwnSseRef]);

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
      setError(prev => (prev[sessionKey] == null ? prev : { ...prev, [sessionKey]: null }));
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
      // The repaired thread comes whole: nothing is missing above it.
      markHistoryComplete(sessionKey);

      cacheMessages(sessionKey, chatMessages);
      return true;
    } catch (err) {
      console.error('Failed to delete message:', err);
      setError(prev => ({ ...prev, [sessionKey]: err instanceof Error ? err.message : 'Failed to delete message' }));
      return false;
    }
  }, [setError]);

  /** Switch to a different branch at a message fork point. */
  const switchBranch = useCallback(async (sessionKey: string, messageId: string, branchIndex: number): Promise<boolean> => {
    try {
      setError(prev => (prev[sessionKey] == null ? prev : { ...prev, [sessionKey]: null }));
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
      // The active thread comes whole: nothing is missing above it.
      markHistoryComplete(sessionKey);

      cacheMessages(sessionKey, chatMessages);
      return true;
    } catch (err) {
      console.error('Failed to switch branch:', err);
      setError(prev => ({ ...prev, [sessionKey]: err instanceof Error ? err.message : 'Failed to switch branch' }));
      return false;
    }
  }, [setError]);

  return { editMessage, regenerateMessage, deleteMessage, switchBranch };
}
