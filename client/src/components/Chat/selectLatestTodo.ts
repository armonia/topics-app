/**
 * Latest-TodoWrite selector (CHAT-TODO-01).
 *
 * The sticky strip above the composer mirrors the CLI's persistent todo:
 * the most recent `TodoWrite` for the session, so the current plan stays in
 * view while the user types instead of scrolling back to the inline card.
 *
 * Pure + framework-free so it unit-tests under bun:test.
 */

import type { ChatMessage, ToolCall } from '../../types';
import { resolveToolDetail } from './toolDetail';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoSnapshot {
  items: TodoItem[];
  done: number;
  total: number;
  /** The item currently in progress, if any (for the collapsed one-liner). */
  active?: TodoItem;
}

function todoItemsFromCall(tc: ToolCall): TodoItem[] | null {
  const detail = resolveToolDetail(tc);
  return detail.type === 'todo' ? detail.items : null;
}

/**
 * Scan messages newest-first for the most recent TodoWrite and return its
 * snapshot. Returns null when the session has no todos, or when the latest
 * todo list is empty (nothing worth pinning).
 */
export function selectLatestTodo(messages: ChatMessage[]): TodoSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const calls = msg.toolCalls;
    if (!calls || calls.length === 0) continue;
    for (let j = calls.length - 1; j >= 0; j--) {
      const items = todoItemsFromCall(calls[j]);
      if (items) {
        if (items.length === 0) return null;
        const done = items.filter((t) => t.status === 'completed').length;
        const active = items.find((t) => t.status === 'in_progress');
        return { items, done, total: items.length, ...(active ? { active } : {}) };
      }
    }
  }
  return null;
}
