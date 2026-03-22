import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ChatRequest, Message, ToolCall, WSMessage } from '../types';
import { chatApi } from '../lib/api';

// --- Message cache helpers (localStorage) ---
const CACHE_PREFIX = 'messages-cache-';
const CACHE_MAX_MESSAGES = 50;
const QUEUE_KEY = 'messages-outbound-queue';

interface QueuedMessage {
  sessionKey: string;
  content: string;
  timestamp: string;
  options?: { planMode?: boolean };
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
  const [orphanedSessions, setOrphanedSessions] = useState<Set<string>>(new Set());
  const [cachedSessions, setCachedSessions] = useState<Set<string>>(new Set());
  const [pendingQueue, setPendingQueue] = useState<QueuedMessage[]>(getOutboundQueue);
  const [expiredMessages, setExpiredMessages] = useState<QueuedMessage[]>([]);
  const abortControllersRef = useRef<Record<string, AbortController>>({});
  const wsHandlersRef = useRef<Set<(event: WSMessage) => void>>(new Set());
  const streamingTimeoutRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Track sessions with active local SSE streams (to avoid double content from WS broadcast)
  const localSSESessionsRef = useRef<Set<string>>(new Set());
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
  const streamQueueRef = useRef<Record<string, { content: string; options?: { planMode?: boolean } }[]>>({});

  // Keep a ref to the latest messages to avoid stale closure in sendMessage
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Ref for sendMessage to allow stream:end to trigger next queued message
  const sendMessageRef = useRef<((sk: string, content: string, opts?: { planMode?: boolean }) => Promise<boolean>) | null>(null);

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

  // Filter out internal gateway context messages
  const isContextMessage = (content: string): boolean => {
    return content.startsWith('[Chat messages since your last reply');
  };

  const addMessage = useCallback((sessionKey: string, message: Omit<ChatMessage, 'id'>) => {
    const newMessage: ChatMessage = {
      ...message,
      id: generateMessageId(),
    };

    setMessages(prev => ({
      ...prev,
      [sessionKey]: [...(prev[sessionKey] || []), newMessage],
    }));

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

  const appendToLastMessage = useCallback((sessionKey: string, contentDelta?: string, thinkingDelta?: string) => {
    setMessages(prev => {
      const sessionMessages = prev[sessionKey] || [];
      const lastMessageIndex = sessionMessages.length - 1;

      if (lastMessageIndex >= 0 && sessionMessages[lastMessageIndex].role === 'assistant') {
        const updatedMessages = [...sessionMessages];
        const lastMsg = sessionMessages[lastMessageIndex];

        // Create a new object without mutating the old state reference
        updatedMessages[lastMessageIndex] = {
          ...lastMsg,
          content: contentDelta ? (lastMsg.content || '') + contentDelta : lastMsg.content,
          thinking: thinkingDelta ? (lastMsg.thinking || '') + thinkingDelta : lastMsg.thinking,
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
        
        if (!lastMsg.toolCalls) lastMsg.toolCalls = [];
        lastMsg.toolCalls.push(toolCall);
        
        updatedMessages[lastMessageIndex] = { ...lastMsg };
        
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
    const sessionKey = event.sessionKey;
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
          const cleanedChunk = stripTopicSwitchMarker(stripBrowserMarker(event.content));
          if (cleanedChunk) appendToLastMessage(sessionKey, cleanedChunk, undefined);
          resetStreamTimeout(sessionKey); // Reset watchdog on each chunk
        }
        break;

      case 'stream:tool_call':
        if (event.toolCall) {
          addToolCallToLastMessage(sessionKey, event.toolCall);
        }
        break;

      case 'stream:tool_result':
        if (event.toolCallId) {
          setMessages(prev => {
            const msgs = [...(prev[sessionKey] || [])];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                const tc = msgs[i].toolCalls!.find(t => t.id === event.toolCallId);
                if (tc) {
                  tc.status = event.status || 'success';
                  tc.result = event.result;
                  msgs[i] = { ...msgs[i] };
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
          if (last?.role === 'assistant' && (last.content.includes('{{BROWSER:') || last.content.includes('{{TOPIC_SWITCH:'))) {
            const updated = [...msgs];
            updated[msgs.length - 1] = { ...last, content: stripTopicSwitchMarker(stripBrowserMarker(last.content)), partial: false };
            // Cache after stream finishes
            cacheMessages(sessionKey, updated);
            return { ...prev, [sessionKey]: updated };
          }
          // Cache after stream finishes
          cacheMessages(sessionKey, msgs);
          return prev;
        });
        updateLastMessage(sessionKey, { partial: false });
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
        // Full buffer catch-up from server on WS connect — set streaming state
        // and create/update the assistant message with accumulated content
        setStreaming(prev => ({ ...prev, [sessionKey]: true }));
        resetStreamTimeout(sessionKey);
        if (event.isThinking) {
          setThinking(prev => ({ ...prev, [sessionKey]: true }));
        }
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          if (lastMsg?.role === 'assistant' && lastMsg.partial) {
            // Update existing partial message with full buffer content
            const updated = [...sessionMessages];
            updated[updated.length - 1] = {
              ...lastMsg,
              content: event.content || '',
              thinking: event.thinking || undefined,
            };
            return { ...prev, [sessionKey]: updated };
          }
          // Create new partial assistant message with buffer content
          return {
            ...prev,
            [sessionKey]: [...sessionMessages, {
              id: event.messageId || generateMessageId(),
              role: 'assistant' as const,
              content: event.content || '',
              thinking: event.thinking || undefined,
              timestamp: new Date().toISOString(),
              partial: true,
            }],
          };
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
    // Handle stream events directly
    if (event.type?.startsWith('stream:') || event.type === 'message:media') {
      handleStreamEvent(event);
    }
    // Forward to registered handlers
    for (const handler of wsHandlersRef.current) {
      try { handler(event); } catch {}
    }
  }, [handleStreamEvent]);

  const sendMessage = useCallback(async (sessionKey: string, content: string, options?: { planMode?: boolean }): Promise<boolean> => {
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

                // Strip browser and topic switch markers from visible content
                if (!isInThinking) chunk = stripTopicSwitchMarker(stripBrowserMarker(chunk));

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

              // Handle tool results
              if (delta?.tool_result) {
                const { id: trId, status: trStatus, result: trResult } = delta.tool_result;
                if (trId) {
                  setMessages(prev => {
                    const msgs = [...(prev[sessionKey] || [])];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i].role === 'assistant' && msgs[i].toolCalls) {
                        const tc = msgs[i].toolCalls!.find(t => t.id === trId);
                        if (tc) {
                          tc.status = trStatus || 'success';
                          tc.result = trResult;
                          msgs[i] = { ...msgs[i] };
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
            if (currentContent.includes('{{BROWSER:') || currentContent.includes('{{TOPIC_SWITCH:')) {
              currentContent = stripTopicSwitchMarker(stripBrowserMarker(currentContent));
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
            content: stripTopicSwitchMarker(stripBrowserMarker(msg.content || '')),
            timestamp: msg.timestamp || new Date().toISOString(),
          }));
        setMessages(prev => ({ ...prev, [sessionKey]: chatMessages }));
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

    // Check if this is the first exchange (1 user + 1 partial assistant)
    const msgs = messagesRef.current[sessionKey] || [];
    const userMsgs = msgs.filter(m => m.role === 'user');
    const isFirstMessage = userMsgs.length <= 1;

    // Tell the server to abort — also clear server-side messages if first message
    chatApi.abort(sessionKey, isFirstMessage).catch(() => {});

    if (isFirstMessage) {
      // Clear session entirely — the chat is brand new
      setMessages(prev => ({ ...prev, [sessionKey]: [] }));
      clearCachedMessages(sessionKey);
    } else {
      updateLastMessage(sessionKey, { partial: false });
    }

    return isFirstMessage;
  }, [updateLastMessage]);

  const loadHistory = useCallback(async (sessionKey: string): Promise<boolean> => {
    // Skip entirely if sendMessage is actively streaming via SSE — it owns the state
    if (localSSESessionsRef.current.has(sessionKey)) return true;

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
          content: stripTopicSwitchMarker(stripBrowserMarker(msg.content || '')),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      setMessages(prev => ({
        ...prev,
        [sessionKey]: chatMessages,
      }));

      // Cache messages for offline fallback
      cacheMessages(sessionKey, chatMessages);
      setCachedSessions(prev => {
        const next = new Set(prev);
        next.delete(sessionKey);
        return next;
      });

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
      // Fall back to localStorage cache
      const cached = getCachedMessages(sessionKey);
      if (cached && cached.length > 0) {
        setMessages(prev => ({ ...prev, [sessionKey]: cached }));
        setCachedSessions(prev => new Set([...prev, sessionKey]));
        setError('Cached messages — may not be current');
      } else {
        // If we already have messages in memory, keep them
        const existing = messagesRef.current[sessionKey];
        if (existing && existing.length > 0) {
          setCachedSessions(prev => new Set([...prev, sessionKey]));
          setError('Cached messages — may not be current');
        } else {
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
          content: stripTopicSwitchMarker(stripBrowserMarker(msg.content || '')),
          timestamp: msg.timestamp || new Date().toISOString(),
        }));

      setMessages(prev => ({
        ...prev,
        [sessionKey]: chatMessages,
      }));

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
                if (!isInThinking) chunk = stripTopicSwitchMarker(stripBrowserMarker(chunk));
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
          content: stripTopicSwitchMarker(stripBrowserMarker(msg.content || '')),
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
    isSessionOrphaned: (sessionKey: string) => orphanedSessions.has(sessionKey),
    isOwnStream: (sessionKey: string) => localSSESessionsRef.current.has(sessionKey),
  };
}
