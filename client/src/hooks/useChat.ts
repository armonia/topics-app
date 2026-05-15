import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ChatRequest, ContentBlock, Message, ToolCall, WSMessage } from '../types';
import { chatApi } from '../lib/api';
import { decideClientWipeOnStop } from './stopSessionPolicy';
import { mergeCatchupIntoPartial } from './streamCatchupMerge';

// --- Message cache helpers (localStorage) ---
const CACHE_PREFIX = 'messages-cache-';
const CACHE_MAX_MESSAGES = 50;
const QUEUE_KEY = 'messages-outbound-queue';

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

interface QueuedMessage {
  sessionKey: string;
  content: string;
  timestamp: string;
  options?: SendMessageOptions;
  id?: string; // unique id for dedup — prevents re-sending already-delivered messages
}

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

function getOutboundQueue(): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushToOutboundQueue(msg: QueuedMessage) {
  try {
    const queue = getOutboundQueue();
    queue.push(msg);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}

function clearOutboundQueue() {
  try { localStorage.removeItem(QUEUE_KEY); } catch {}
}

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

export function useChat() {
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>(getInitialMessages);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [streaming, setStreaming] = useState<Record<string, boolean>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [gatewayConnected, setGatewayConnected] = useState(true); // Assume connected until told otherwise
  const [orphanedSessions, setOrphanedSessions] = useState<Set<string>>(new Set());
  const [cachedSessions, setCachedSessions] = useState<Set<string>>(new Set());
  const [pendingQueue, setPendingQueue] = useState<QueuedMessage[]>(getOutboundQueue);
  const [expiredMessages, setExpiredMessages] = useState<QueuedMessage[]>([]);
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
  const HISTORY_DEDUP_MS = 5_000;
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

  // Keep a ref to the latest messages to avoid stale closure in sendMessage
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Ref for sendMessage to allow stream:end to trigger next queued message
  const sendMessageRef = useRef<((sk: string, content: string, opts?: SendMessageOptions) => Promise<boolean>) | null>(null);

  // Auto-clear stuck streams after 3 minutes of no activity
  const STREAM_TIMEOUT_MS = 3 * 60 * 1000;
  
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

  const generateMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Strip {{BROWSER:...}} markers from visible content (processed server-side for navigation)
  const stripBrowserMarker = (text: string): string => text.replace(/\{\{BROWSER:.*?\}\}/g, '');
  // Strip {{TOPIC_SWITCH:...}} and {{TOPIC_NEW:...}} markers from visible content (processed server-side for topic switching)
  const stripTopicSwitchMarker = (text: string): string => text.replace(/\{\{TOPIC_SWITCH:[\w-]+\}\}\s*/g, '').replace(/\{\{TOPIC_NEW:[^}]+\}\}\s*/g, '');
  // Strip {{PROJECT_CREATE:...}} and {{PROJECT_OPEN:...}} markers (server-side processed; previously leaked to UI — audit fix).
  const stripProjectMarker = (text: string): string => text.replace(/\{\{PROJECT_CREATE:[^}]+\}\}\s*/g, '').replace(/\{\{PROJECT_OPEN:[^}]+\}\}\s*/g, '');
  /**
   * Single entry point for stripping every server-side internal marker from
   * a visible string. The 9+ call sites in this file previously applied 2 of
   * the 3 marker families inconsistently (PROJECT_* leaked); centralising
   * makes the contract obvious and prevents regression when a new marker is
   * added. Also defensively strips an *unclosed* marker at end-of-string —
   * mirrors the server-side OPEN_MARKER_TAIL_REGEX in routes/topics.ts, so a
   * chunk-split delta that lands on the client without a closing `}}` doesn't
   * surface as raw `{{NAME:partial` text.
   */
  const cleanInvisibleMarkers = (text: string): string => {
    const closedStripped = stripProjectMarker(stripTopicSwitchMarker(stripBrowserMarker(text)));
    return closedStripped.replace(/\{\{(?:BROWSER|TOPIC_SWITCH|TOPIC_NEW|PROJECT_CREATE|PROJECT_OPEN):[^}]*$/, '');
  };

  // Filter out internal gateway context messages
  const isContextMessage = (content: string): boolean => {
    return content.startsWith('[Chat messages since your last reply');
  };

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
  const handleStreamEvent = useCallback((event: WSMessage) => {
    // Every stream:* and message:media variant carries a sessionKey, but the
    // dispatcher upstream accepts the full WSMessage union (which includes
    // events that don't). Narrow via `in` so the rest of this function can
    // use `sessionKey` without per-case re-narrowing on each switch arm.
    const sessionKey = 'sessionKey' in event ? (event as { sessionKey?: string }).sessionKey : undefined;
    if (!sessionKey) return;

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
              id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
          appendToLastMessage(sessionKey, undefined, event.content);
        }
        break;

      case 'stream:thinking_end':
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        break;

      case 'stream:content_chunk':
        if (event.content) {
          const cleanedChunk = cleanInvisibleMarkers(event.content);
          if (cleanedChunk) appendToLastMessage(sessionKey, cleanedChunk, undefined);
          resetStreamTimeout(sessionKey); // Reset watchdog on each chunk
        }
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
          if (last?.role === 'assistant' && (last.content.includes('{{BROWSER:') || last.content.includes('{{TOPIC_SWITCH:') || last.content.includes('{{TOPIC_NEW:') || last.content.includes('{{PROJECT_'))) {
            const updated = [...msgs];
            updated[msgs.length - 1] = { ...last, content: cleanInvisibleMarkers(last.content), partial: false };
            // Cache after stream finishes
            cacheMessages(sessionKey, updated);
            return { ...prev, [sessionKey]: updated };
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
  }, [appendToLastMessage, addToolCallToLastMessage, updateLastMessage, resetStreamTimeout, clearStreamTimeout]);

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
      console.log(`[useChat] Message queued (send-locked) for ${sessionKey} — will auto-send on stream:end`);
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
      let currentThinking = '';
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
                    currentThinking = chunk;
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
                    currentThinking += chunk;
                    thinkingBatch += chunk;
                  } else if (chunk) {
                    currentContent += chunk;
                    contentBatch += chunk;
                  }
                }
              }

              // Handle tool calls
              if (delta?.tool_calls) {
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

          // Flush batched deltas as a single state update
          if (contentBatch || thinkingBatch) {
            appendToLastMessage(sessionKey, contentBatch || undefined, thinkingBatch || undefined);
          }

          // Finalize after flushing so content is up to date
          if (isDone && assistantMessageCreated) {
            if (currentContent.includes('{{BROWSER:') || currentContent.includes('{{TOPIC_SWITCH:') || currentContent.includes('{{TOPIC_NEW:') || currentContent.includes('{{PROJECT_')) {
              currentContent = cleanInvisibleMarkers(currentContent);
              updateLastMessage(sessionKey, { content: currentContent, partial: false });
            } else {
              updateLastMessage(sessionKey, { partial: false });
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Reload full history to sync server-generated IDs and branching metadata
      try {
        const historyResponse = await chatApi.getHistory(sessionKey, { limit: 100 });
        const chatMessages: ChatMessage[] = historyResponse.messages
          .filter((msg: any) => !isContextMessage(msg.content))
          .map((msg: any) => ({
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
      const is409 = err && typeof err === 'object' && 'status' in err && (err as any).status === 409;
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
        console.log(`[useChat] Message queued for ${sessionKey} — will auto-send on stream:end`);
        return true; // Return true since we accepted the message
      }

      // Only queue if the server never received the request (fetch itself failed).
      // If streamStarted=true, the server already has the message — do NOT re-queue.
      const isNetworkError = err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'));
      if (isNetworkError && !streamStarted) {
        const queued: QueuedMessage = { sessionKey, content, timestamp: new Date().toISOString(), options, id: crypto.randomUUID() };
        pushToOutboundQueue(queued);
        setPendingQueue(prev => [...prev, queued]);
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
  }, [addMessage, appendToLastMessage, addToolCallToLastMessage, updateLastMessage]);

  // Keep sendMessage ref in sync for stream:end auto-drain
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const getSessionMessages = useCallback((sessionKey: string): ChatMessage[] => {
    return (messages[sessionKey] || []).filter(msg => !isContextMessage(msg.content));
  }, [messages]);

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
  }, [updateLastMessage]);

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

    try {
      setError(null);
      setLoading(prev => ({ ...prev, [sessionKey]: true }));
      // Clear stale streaming/thinking state before server confirms the real state
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      
      const response = await chatApi.getHistory(sessionKey, { limit: 100 });

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
      const filtered = queue.filter(q => q.sessionKey !== sessionKey);
      if (filtered.length !== queue.length) {
        if (filtered.length === 0) clearOutboundQueue();
        else try { localStorage.setItem(QUEUE_KEY, JSON.stringify(filtered)); } catch {}
        setPendingQueue(filtered);
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
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
    }
  }, [resetStreamTimeout]);

  /** Edit a user message — creates a new branch and streams the assistant response. */
  const editMessage = useCallback(async (sessionKey: string, messageId: string, newContent: string): Promise<boolean> => {
    // Prevent concurrent edits/sends for the same session
    if (isSendLocked(sessionKey)) {
      console.warn(`[useChat] editMessage blocked — already sending for ${sessionKey}`);
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

      const stream = await chatApi.editMessage(messageId, newContent, abortController.signal);
      if (!stream) throw new Error('No stream received');

      // Reload the full thread from server (the edit endpoint created the branch)
      // We do this to get the updated thread with the new branch
      const historyResponse = await chatApi.getHistory(sessionKey, { limit: 100 });
      const chatMessages: ChatMessage[] = historyResponse.messages
        .filter((msg: any) => !isContextMessage(msg.content))
        .map((msg: any) => ({
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
      let currentContent = '';
      let currentThinking = '';
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
                if (isInThinking) { currentThinking += chunk; thinkingBatch += chunk; }
                else if (chunk) { currentContent += chunk; contentBatch += chunk; }
              }
            } catch {}
          }

          if (contentBatch || thinkingBatch) {
            appendToLastMessage(sessionKey, contentBatch || undefined, thinkingBatch || undefined);
          }
          if (isDone) {
            updateLastMessage(sessionKey, { partial: false });
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Reload full history to get accurate sibling counts
      await loadHistory(sessionKey);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return true;
      console.error('Failed to edit message:', err);
      setError(err instanceof Error ? err.message : 'Failed to edit message');
      return false;
    } finally {
      releaseSendLock(sessionKey); // Release send lock
      localSSESessionsRef.current.delete(sessionKey);
      setLoading(prev => ({ ...prev, [sessionKey]: false }));
      setStreaming(prev => ({ ...prev, [sessionKey]: false }));
      setThinking(prev => ({ ...prev, [sessionKey]: false }));
      delete abortControllersRef.current[sessionKey];
    }
  }, [addMessage, appendToLastMessage, updateLastMessage, loadHistory]);

  /** Switch to a different branch at a message fork point. */
  const switchBranch = useCallback(async (sessionKey: string, messageId: string, branchIndex: number): Promise<boolean> => {
    try {
      setError(null);
      const response = await chatApi.switchBranch(messageId, branchIndex);

      const chatMessages: ChatMessage[] = response.messages
        .filter((msg: any) => !isContextMessage(msg.content))
        .map((msg: any) => ({
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
  }, []);

  // Drain outbound queue on reconnect
  const drainQueue = useCallback(async () => {
    // Prevent concurrent drains (e.g. rapid WS reconnects)
    if (drainingRef.current) return;
    drainingRef.current = true;

    try {
      const queue = getOutboundQueue();
      if (queue.length === 0) return;

      clearOutboundQueue();
      setPendingQueue([]);

      // Discard stale queued messages (>5min old)
      const MAX_QUEUE_AGE_MS = 5 * 60 * 1000;
      const now = Date.now();

      for (const item of queue) {
        const age = now - new Date(item.timestamp).getTime();
        if (age > MAX_QUEUE_AGE_MS) {
          setExpiredMessages(prev => [...prev, item]);
          continue;
        }

        // Skip if session already has an active send (sendMessage guard will also block, but avoid the UI churn)
        if (isSendLocked(item.sessionKey)) {
          continue;
        }

        // Dedup: skip if this message was already delivered or is currently being processed.
        const sessionMsgs = messagesRef.current[item.sessionKey] || [];
        const userMsgIdx = sessionMsgs.findLastIndex(m => m.role === 'user' && m.content === item.content && !m.queued);
        if (userMsgIdx >= 0) {
          const msgsAfter = sessionMsgs.slice(userMsgIdx + 1);
          // Already delivered (has assistant response)
          const alreadyDelivered = msgsAfter.some(m => m.role === 'assistant' && m.content);
          // Still in-flight: assistant is streaming (partial) or user msg was already un-queued (partial: false)
          const inFlight = msgsAfter.some(m => m.role === 'assistant') || isSendLocked(item.sessionKey);
          if (alreadyDelivered || inFlight) {
            console.log(`[useChat] Skipping queued message (${alreadyDelivered ? 'delivered' : 'in-flight'}) for ${item.sessionKey}`);
            continue;
          }
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
        } catch {
          // If still failing, re-queue
          pushToOutboundQueue(item);
          setPendingQueue(prev => [...prev, item]);
        }
      }
    } finally {
      drainingRef.current = false;
      // Clear any "queued" error banner now that we've processed the queue
      setError(prev => (prev?.includes('queued') ? null : prev));
    }
  }, []);

  const retryExpired = useCallback(async (item: QueuedMessage) => {
    setExpiredMessages(prev => prev.filter(m => m !== item));
    try {
      await sendMessageRef.current?.(item.sessionKey, item.content, item.options);
    } catch {
      setExpiredMessages(prev => [...prev, item]);
    }
  }, []);

  const clearExpired = useCallback(() => {
    setExpiredMessages([]);
  }, []);

  const isSessionCached = useCallback((sessionKey: string): boolean => {
    return cachedSessions.has(sessionKey);
  }, [cachedSessions]);

  return {
    sendMessage,
    editMessage,
    switchBranch,
    stopSession,
    getSessionMessages,
    isSessionLoading,
    isSessionStreaming,
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
