import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ChatRequest, CompactionMarker, ContentBlock, HistoryMessage, Message, ToolCall, WSMessage } from '../types';
import { chatApi } from '../lib/api';
import { bumpAura } from '../lib/auraActivity';
import { decideClientWipeOnStop } from './stopSessionPolicy';
import { mergeCatchupIntoPartial } from './streamCatchupMerge';
import { useRefMirror } from './useRefMirror';
import { reconcileOrphanStreams } from '../state/signals';
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

// Auto-clear stuck streams after 3 minutes of no activity. Module-scoped
// constant — no per-render identity, so it's not a hook dependency.
const STREAM_TIMEOUT_MS = 3 * 60 * 1000;

const generateMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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
  planMode?: boolean;
  /**
   * Fast Mode flag for this turn. Forwarded as `chatRequest.fastMode`; the
   * server resolves the actual model via `getFastModelFor(provider.name)`.
   * Picker (`options.model`) wins over fast — see openspec change
   * `chat-fast-mode`.
   */
  fastMode?: boolean;
  provider?: string;
  model?: string;
}

export type { QueuedMessage };

function cacheMessages(sessionKey: string, msgs: ChatMessage[]) {
  try {
    const toCache = msgs
      .filter(m => !m.partial)
      .slice(-CACHE_MAX_MESSAGES);
    localStorage.setItem(CACHE_PREFIX + sessionKey, JSON.stringify(toCache));
  } catch {}
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

const getOutboundQueue = (): QueuedMessage[] => readQueue(queueStorage, OUTBOUND_QUEUE_KEY);
const getExpiredQueue = (): QueuedMessage[] => readQueue(queueStorage, EXPIRED_QUEUE_KEY);

function getInitialMessages(): Record<string, ChatMessage[]> {
  try {
    const result: Record<string, ChatMessage[]> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) {
        const sessionKey = key.slice(CACHE_PREFIX.length);
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) result[sessionKey] = parsed;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

// Shared stable empty array so getSessionMessages returns a reference-equal
// result for a session with no messages (a fresh `[]` per call would be a cache
// miss every time and hand consumers a new identity each render).
const EMPTY_MESSAGES: ChatMessage[] = [];

export function useChat() {
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>(getInitialMessages);
  // Compaction dividers per session (CHAT-COMPACT-01): display-only, merged
  // into the transcript by afterMessageId in MessageList. Populated live via
  // stream:compaction and on reload from /api/history.
  const [compactionMarkers, setCompactionMarkers] = useState<Record<string, CompactionMarker[]>>({});
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
  const [error, setError] = useState<string | null>(null);
  const [gatewayConnected, setGatewayConnected] = useState(true); // Assume connected until told otherwise
  const [orphanedSessions, setOrphanedSessions] = useState<Set<string>>(new Set());
  const [cachedSessions, setCachedSessions] = useState<Set<string>>(new Set());
  const [pendingQueue, setPendingQueue] = useState<QueuedMessage[]>(getOutboundQueue);
  // Gli scaduti si idratano dallo storage, non partono vuoti: il banner "N
  // messages not sent" col retry deve sopravvivere al reload, altrimenti la
  // scadenza equivale a buttare via il messaggio senza dirlo.
  const [expiredMessages, setExpiredMessages] = useState<QueuedMessage[]>(getExpiredQueue);
  const abortControllersRef = useRef<Record<string, AbortController>>({});
  const wsHandlersRef = useRef<Set<(event: WSMessage) => void>>(new Set());
  const streamingTimeoutRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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
  // Stream queue: messages queued while AI is streaming (auto-sent on stream:end)
  const streamQueueRef = useRef<Record<string, { content: string; options?: SendMessageOptions }[]>>({});

  // Keep a ref to the latest messages to avoid stale closure in sendMessage.
  // useRefMirror is the canonical helper for this state→ref bridge.
  const messagesRef = useRefMirror(messages);
  // Live mirror of the streaming map so the server-reconciler (below) reads the
  // freshest flags without being re-created on every streaming change.
  const streamingRef = useRefMirror(streaming);
  // Per-session count of consecutive polls where the server said "not streaming"
  // while we still showed it streaming. Drives the orphan-clear threshold.
  const streamMissRef = useRef<Map<string, number>>(new Map());
  // Ref for sendMessage to allow stream:end to trigger next queued message
  const sendMessageRef = useRef<((sk: string, content: string, opts?: SendMessageOptions) => Promise<boolean>) | null>(null);

  const resetStreamTimeout = useCallback((sessionKey: string) => {
    // Clear existing timeout
    if (streamingTimeoutRef.current[sessionKey]) {
      clearTimeout(streamingTimeoutRef.current[sessionKey]);
    }
    // Set new timeout
    streamingTimeoutRef.current[sessionKey] = setTimeout(() => {
      console.warn(`[useChat] Stream timeout for ${sessionKey}, auto-clearing`);
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
    }, STREAM_TIMEOUT_MS);
  }, []);

  const clearStreamTimeout = useCallback((sessionKey: string) => {
    if (streamingTimeoutRef.current[sessionKey]) {
      clearTimeout(streamingTimeoutRef.current[sessionKey]);
      delete streamingTimeoutRef.current[sessionKey];
    }
  }, []);

  // On unmount, clear any outstanding stream watchdog timers and abort in-flight
  // SSE requests so neither leaks past the hook's lifetime.
  useEffect(() => () => {
    for (const id of Object.values(streamingTimeoutRef.current)) clearTimeout(id);
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
    for (const sk of orphans) clearStreamTimeout(sk);
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
      if (newMessage.id && existing.some(m => m.id === newMessage.id)) {
        return prev;
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
      const last = existing[existing.length - 1];
      if (message.id && newMessage.role === 'assistant' && last?.role === 'assistant' && last.partial) {
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
      const lastMessageIndex = sessionMessages.length - 1;
      
      if (lastMessageIndex >= 0 && sessionMessages[lastMessageIndex].role === 'assistant') {
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
    // Feed the working aura: every streamed delta (SSE foreground + WS cross-
    // window both funnel through here) drives the wave's speed. Weight by the
    // delta LENGTH (≈ token count) so the energy tracks real token THROUGHPUT —
    // a fast stream keeps it high, a lull lets it decay — not just chunk arrival
    // rate. Keyed by sessionKey, exactly what the aura reads (topic.sessionKey).
    const deltaLen = (contentDelta ? contentDelta.length : 0) + (thinkingDelta ? thinkingDelta.length : 0);
    if (deltaLen > 0) bumpAura(sessionKey, 0.06 + Math.min(0.5, deltaLen / 55));
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = sessionMessages.length - 1;

      if (lastMessageIndex >= 0 && sessionMessages[lastMessageIndex].role === 'assistant') {
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
      const lastMessageIndex = sessionMessages.length - 1;

      if (lastMessageIndex >= 0 && sessionMessages[lastMessageIndex].role === 'assistant') {
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

  // Drop any buffered deltas on unmount (server holds the authoritative copy;
  // this window re-syncs via loadHistory). No setState on a dead component.
  useEffect(() => () => {
    if (liveDeltaRafRef.current != null) cancelAnimationFrame(liveDeltaRafRef.current);
    liveDeltaBufferRef.current.clear();
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

    // Skip WS stream events for sessions with an active local SSE stream
    // (sendMessage already processes these via HTTP response — avoid double content)
    if (localSSESessionsRef.current.has(sessionKey)) return;

    switch (event.type) {
      case 'stream:start':
        setStreaming(prev => ({ ...prev, [sessionKey]: true }));
        resetStreamTimeout(sessionKey); // Start timeout watchdog
        // Only create assistant placeholder if there isn't already a partial one
        // (sendMessage creates one via SSE, so WS broadcast to OTHER windows only)
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          if (lastMsg?.role === 'assistant' && lastMsg.partial) {
            // Already have a partial assistant message — skip duplicate
            return prev;
          }
          // No partial assistant msg — this is from another window, create placeholder
          return {
            ...prev,
            [sessionKey]: [...sessionMessages, {
              id: generateMessageId(),
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
        if (event.toolCallId) {
          setMessages(prev => {
            const msgs = [...(prev[sessionKey] || [])];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                const tcIdx = msgs[i].toolCalls!.findIndex(t => t.id === event.toolCallId);
                if (tcIdx >= 0) {
                  // Replace the ToolCall with a new instance so React.memo
                  // on MessageContent sees a real prop change. Mirror the
                  // change into both the legacy `toolCalls` bucket and the
                  // chronological `blocks` timeline.
                  const oldTc = msgs[i].toolCalls![tcIdx];
                  const newTc: ToolCall = {
                    ...oldTc,
                    status: ((event.status as ToolCall['status']) || 'success'),
                    result: event.result as string | undefined,
                    error: (event.error as string | undefined) ?? oldTc.error,
                    detail: (event.detail as ToolCall['detail']) ?? oldTc.detail,
                    // Server stamps the real-usage close on the result event;
                    // durations render from endedAt - startedAt.
                    endedAt: (typeof event.endedAt === 'number' ? event.endedAt : undefined) ?? oldTc.endedAt,
                  };
                  const nextToolCalls = msgs[i].toolCalls!.slice();
                  nextToolCalls[tcIdx] = newTc;
                  let nextBlocks = msgs[i].blocks;
                  if (nextBlocks) {
                    nextBlocks = nextBlocks.map(b =>
                      b.kind === 'tool' && b.toolCall.id === event.toolCallId
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
        break;

      case 'stream:tool_update':
        // Live partial result from a long-running tool (e.g. a Bash that
        // streams output). Server's openclaw provider emits these via
        // gateway-ws; claude-code currently doesn't (it only sees cumulative
        // assistant snapshots). Patch the running tool's `result` field with
        // the partial so the user sees output flowing in instead of staring
        // at a spinner. Status stays 'running' — the terminal status comes
        // later via stream:tool_result.
        if (event.toolCallId && typeof event.partialResult === 'string') {
          setMessages(prev => {
            const msgs = [...(prev[sessionKey] || [])];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                const tcIdx = msgs[i].toolCalls!.findIndex(t => t.id === event.toolCallId);
                if (tcIdx >= 0) {
                  const oldTc = msgs[i].toolCalls![tcIdx];
                  const partialResult = event.partialResult as string;
                  const newTc: ToolCall = { ...oldTc, result: partialResult };
                  const nextToolCalls = msgs[i].toolCalls!.slice();
                  nextToolCalls[tcIdx] = newTc;
                  let nextBlocks = msgs[i].blocks;
                  if (nextBlocks) {
                    nextBlocks = nextBlocks.map(b =>
                      b.kind === 'tool' && b.toolCall.id === event.toolCallId
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
        break;

      case 'stream:tool_detail':
        // Sub-agent (Task) snapshot update from the server's SidechainTracker.
        // Patches the parent Task tool's `detail` field with the latest
        // actions[] log so the renderer's <SubAgentCard> can show live progress.
        // Snapshot, not delta — replace the whole detail.
        if (event.toolCallId && event.detail) {
          setMessages(prev => {
            const msgs = [...(prev[sessionKey] || [])];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                const tcIdx = msgs[i].toolCalls!.findIndex(t => t.id === event.toolCallId);
                if (tcIdx >= 0) {
                  const oldTc = msgs[i].toolCalls![tcIdx];
                  const newTc: ToolCall = {
                    ...oldTc,
                    detail: event.detail as ToolCall['detail'],
                  };
                  const nextToolCalls = msgs[i].toolCalls!.slice();
                  nextToolCalls[tcIdx] = newTc;
                  let nextBlocks = msgs[i].blocks;
                  if (nextBlocks) {
                    nextBlocks = nextBlocks.map(b =>
                      b.kind === 'tool' && b.toolCall.id === event.toolCallId
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
          setMessages(prev => {
            const msgs = [...(prev[sessionKey] || [])];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                const tcIdx = msgs[i].toolCalls!.findIndex(t => t.id === event.toolCallId);
                if (tcIdx >= 0) {
                  const oldTc = msgs[i].toolCalls![tcIdx];
                  const newTc: ToolCall = {
                    ...oldTc,
                    status: 'waiting_for_input',
                    userInputSchema: event.schema,
                  };
                  const nextToolCalls = msgs[i].toolCalls!.slice();
                  nextToolCalls[tcIdx] = newTc;
                  let nextBlocks = msgs[i].blocks;
                  if (nextBlocks) {
                    nextBlocks = nextBlocks.map(b =>
                      b.kind === 'tool' && b.toolCall.id === event.toolCallId
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
        break;

      case 'stream:error':
        clearStreamTimeout(sessionKey);
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
        // Strip any remaining browser markers (handles split-across-chunks case)
        setMessages(prev => {
          const msgs = prev[sessionKey] || [];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            // Always run through the centralized cleaner so detection tracks the
            // full marker set; only rewrite if it actually changed something.
            const cleaned = cleanInvisibleMarkers(last.content);
            if (cleaned !== last.content) {
              const updated = [...msgs];
              updated[msgs.length - 1] = { ...last, content: cleaned, partial: false };
              // Cache after stream finishes
              cacheMessages(sessionKey, updated);
              return { ...prev, [sessionKey]: updated };
            }
          }
          // Cache after stream finishes
          cacheMessages(sessionKey, msgs);
          return prev;
        });
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
          updateLastMessage(sessionKey, finalPatch);
        }
        // Auto-send next queued message for this session (if any)
        {
          const queue = streamQueueRef.current[sessionKey];
          if (queue && queue.length > 0) {
            const next = queue.shift()!;
            if (queue.length === 0) delete streamQueueRef.current[sessionKey];
            // Delay slightly to let state settle before next send
            setTimeout(() => {
              sendMessageRef.current?.(sessionKey, next.content, next.options);
            }, 100);
          }
        }
        break;

      case 'stream:catchup':
        // Full buffer catch-up from server on WS connect — set streaming
        // state and create/update the assistant message with accumulated
        // state. The merge logic (which carries toolCalls + blocks from
        // the DB partial row through to the client) lives in
        // `streamCatchupMerge.ts` so it can be unit-tested without React.
        setStreaming(prev => ({ ...prev, [sessionKey]: true }));
        resetStreamTimeout(sessionKey);
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
  }, [addToolCallToLastMessage, updateLastMessage, resetStreamTimeout, clearStreamTimeout, bufferLiveDelta, flushLiveDeltas, upsertMarker]);

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
    // Forward to registered handlers
    for (const handler of wsHandlersRef.current) {
      try { handler(event); } catch {}
    }
  }, [handleStreamEvent]);

  const sendMessage = useCallback(async (sessionKey: string, content: string, options?: SendMessageOptions): Promise<boolean> => {
    // If there's an active send/stream for this session, queue the message for later
    if (isSendLocked(sessionKey)) {
      // Show user message immediately, queue content for auto-send on stream:end
      addMessage(sessionKey, { role: 'user', content, timestamp: new Date().toISOString() });
      if (!streamQueueRef.current[sessionKey]) streamQueueRef.current[sessionKey] = [];
      streamQueueRef.current[sessionKey].push({ content, options });
      return true;
    }
    acquireSendLock(sessionKey);

    let streamStarted = false; // Track if server received the request (don't re-queue if true)
    localSSESessionsRef.current.add(sessionKey); // Block WS duplicates for this session

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

      const sessionMessages = messagesRef.current[sessionKey] || [];
      const apiMessages: Message[] = [
        ...sessionMessages.map(msg => ({ role: msg.role, content: msg.content })),
        { role: 'user', content }
      ];

      setStreaming(prev => ({ ...prev, [sessionKey]: true }));

      // Create placeholder assistant message immediately for inline loading
      addMessage(sessionKey, {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        partial: true,
      });

      const chatRequest: ChatRequest = { sessionKey, messages: apiMessages };
      if (options?.planMode) chatRequest.planMode = true;
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

      // Auto-send next queued message (Claude Code-style queue drain)
      {
        const queue = streamQueueRef.current[sessionKey];
        if (queue && queue.length > 0) {
          const next = queue.shift()!;
          if (queue.length === 0) delete streamQueueRef.current[sessionKey];
          setTimeout(() => {
            sendMessageRef.current?.(sessionKey, next.content, next.options);
          }, 200);
        }
      }

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
      if (is409) {
        // Remove the optimistic assistant placeholder but keep the user message visible
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const last = sessionMessages[sessionMessages.length - 1];
          // Remove assistant placeholder (last added), keep user message
          if (last?.role === 'assistant' && last.partial && !last.content) {
            return { ...prev, [sessionKey]: sessionMessages.slice(0, -1) };
          }
          return prev;
        });
        // Queue for auto-send on stream:end
        if (!streamQueueRef.current[sessionKey]) streamQueueRef.current[sessionKey] = [];
        streamQueueRef.current[sessionKey].push({ content, options });
        return true; // Return true since we accepted the message
      }

      // Only queue if the server never received the request (fetch itself failed).
      // If streamStarted=true, the server already has the message — do NOT re-queue.
      const isNetworkError = err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'));
      if (isNetworkError && !streamStarted) {
        const queued: QueuedMessage = { sessionKey, content, timestamp: new Date().toISOString(), options, id: crypto.randomUUID() };
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
        setError('Message queued — will send when reconnected');
        return false;
      }

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
      localSSESessionsRef.current.delete(sessionKey); // Re-enable WS events for this session
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
    }
  }, [addMessage, addToolCallToLastMessage, updateLastMessage, messagesRef, bufferLiveDelta, flushLiveDeltas]);

  // Keep sendMessage ref in sync for stream:end auto-drain
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const getSessionMessages = useCallback((sessionKey: string): ChatMessage[] => {
    const src = messages[sessionKey] || EMPTY_MESSAGES;
    const cache = filteredMessagesCacheRef.current;
    const hit = cache.get(sessionKey);
    // Same source array ⇒ same filtered result: return the cached reference so
    // callers (and their useMemos) can bail on identity.
    if (hit && hit.src === src) return hit.out;
    const out = src.filter(msg => !isContextMessage(msg.content));
    cache.set(sessionKey, { src, out });
    return out;
  }, [messages]);

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

  /** Stop streaming. Returns true if this was the first message (chat can be discarded). */
  const stopSession = useCallback((sessionKey: string): boolean => {
    const controller = abortControllersRef.current[sessionKey];
    if (controller) {
      controller.abort();
    }

    // Decide whether this is a brand-new chat that can be wiped client-side.
    // We MUST consult `hydratedSessionsRef`: until `loadHistory` has run for
    // this session, `messagesRef.current[sessionKey]` is empty for non-content
    // reasons (initial mount race, hot reload, WS reconnect) and would
    // falsely claim "first message" on a thread the server has on disk.
    // See `stopSessionPolicy.ts` for the full rationale and the matching
    // server-side guard in `server/routes/abortClearPolicy.ts`.
    const hydrated = hydratedSessionsRef.current.has(sessionKey);
    const msgs = messagesRef.current[sessionKey] || [];
    const userMsgs = msgs.filter(m => m.role === 'user');
    const isFirstMessage = decideClientWipeOnStop(hydrated, userMsgs.length);

    // Tell the server to abort — also clear server-side messages if first message
    chatApi.abort(sessionKey, isFirstMessage).catch(() => {});

    if (isFirstMessage) {
      // Clear session entirely — the chat is brand new
      setMessages(prev => ({ ...prev, [sessionKey]: [] }));
      clearCachedMessages(sessionKey);
      // We just emptied the local map; future stop clicks on this key
      // must re-hydrate from the server before they can wipe again.
      hydratedSessionsRef.current.delete(sessionKey);
    } else {
      updateLastMessage(sessionKey, { partial: false });
    }

    return isFirstMessage;
  }, [updateLastMessage, messagesRef]);

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
        const fetchedIds = new Set(chatMessages.map(m => m.id));
        const localOnly = existing.filter(m => m.id && !fetchedIds.has(m.id));
        const merged = localOnly.length > 0
          ? [...chatMessages, ...localOnly]
          : chatMessages;
        return { ...prev, [sessionKey]: merged };
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
        setStreaming(prev => ({ ...prev, [sessionKey]: true }));
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
  }, [resetStreamTimeout, messagesRef]);

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

    localSSESessionsRef.current.add(sessionKey);
    const abortController = new AbortController();
    abortControllersRef.current[sessionKey] = abortController;

    try {
      setError(null);
      setStreaming(prev => ({ ...prev, [sessionKey]: true }));
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
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return true;
      console.error(`Failed to ${label}:`, err);
      setError(err instanceof Error ? err.message : `Failed to ${label}`);
      return false;
    } finally {
      releaseSendLock(sessionKey); // Release send lock
      localSSESessionsRef.current.delete(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
    }
  }, [addMessage, updateLastMessage, loadHistory, bufferLiveDelta, flushLiveDeltas]);

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

  const clearSession = useCallback((sessionKey: string) => {
    setMessages(prev => ({
      ...prev,
      [sessionKey]: [],
    }));
    clearCachedMessages(sessionKey);
    // Evict this session's per-session caches too. `useChat` is a single
    // app-lifetime instance (mounted once in App.tsx), so these Maps/Sets would
    // otherwise grow with every topic ever opened and never shrink on removal.
    // Dropping them here also makes a re-open correctly re-hydrate from server
    // rather than trusting a stale "already hydrated" flag over wiped messages.
    filteredMessagesCacheRef.current.delete(sessionKey);
    lastHistoryFetchAtRef.current.delete(sessionKey);
    hydratedSessionsRef.current.delete(sessionKey);
  }, []);

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
          await sendMessageRef.current!(item.sessionKey, item.content, item.options);
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
  }, [messagesRef, scheduleDrainRetry]);
  drainQueueRef.current = drainQueue;

  const retryExpired = useCallback(async (item: QueuedMessage) => {
    const key = queueItemKey(item);
    const without = (list: QueuedMessage[]) => list.filter(m => queueItemKey(m) !== key);
    writeQueue(queueStorage, EXPIRED_QUEUE_KEY, without(getExpiredQueue()));
    setExpiredMessages(prev => without(prev));
    try {
      await sendMessageRef.current?.(item.sessionKey, item.content, item.options);
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
    getStreamQueueSize: (sessionKey: string) => streamQueueRef.current[sessionKey]?.length || 0,
    error,
    gatewayConnected,
    isSessionOrphaned: (sessionKey: string) => orphanedSessions.has(sessionKey),
    isOwnStream: (sessionKey: string) => localSSESessionsRef.current.has(sessionKey),
  };
}
