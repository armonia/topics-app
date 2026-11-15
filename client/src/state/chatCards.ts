/**
 * THE CARDS A CHAT SENT TO WORK, read off its own transcript.
 *
 * A chat that creates a card or sends one back is waiting on it. The server
 * keeps the opener on the row (`openerTopicId`), but a card the chat only sent
 * back was opened by somebody else: the id the tool returned is what ties it
 * to this chat. Pure over the messages, so the waiting line and the sidebar
 * read the same set.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { taskToolCall, taskToolStartsWait } from '../../../shared/task-tool';
import type { ChatMessage } from '../types';
import { getSessionMessagesFromStore, subscribeSession } from './messageStore';

const NONE: ReadonlySet<string> = new Set();

export function cardIdsSentToWork(messages: readonly ChatMessage[]): ReadonlySet<string> {
  let ids: Set<string> | null = null;
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.status === 'error' || tc.error) continue;
      const call = taskToolCall(tc.name, tc.args, tc.result);
      if (call?.taskId && taskToolStartsWait(call)) (ids ??= new Set()).add(call.taskId);
    }
  }
  return ids ?? NONE;
}

export function useChatCardIds(sessionKey: string | undefined): ReadonlySet<string> {
  const subscribe = useCallback((cb: () => void) => (sessionKey ? subscribeSession(sessionKey, cb) : () => {}), [sessionKey]);
  const snapshot = useCallback(() => (sessionKey ? getSessionMessagesFromStore(sessionKey) : []), [sessionKey]);
  const messages = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => cardIdsSentToWork(messages), [messages]);
}
