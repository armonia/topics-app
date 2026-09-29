/**
 * The notification registry's UNSEEN SUBJECTS, as this window last heard them.
 *
 * The bell hook (`useNotificationHistory`) owns the reading and its guards
 * against late frames; it publishes here what it settled on. Two readers need
 * it outside the bell:
 *   - the one global number (`chromeAttentionTotal`), which counts the union of
 *     what is asking for something and what has an unseen notification, so the
 *     dock and the bell cannot tell two different stories;
 *   - the chat's "seen" on opening (`useWebSocket`), which must reach the server
 *     when the chat has an unseen notification even if its unread is already 0.
 *
 * Keys are the server's: a row's group key (`topic:<id>`, `task:<id>`,
 * `terminal:<id>`) or, for an ungrouped row, its id.
 */
import { create } from 'zustand';
import type { UnreadData } from '../types';
import { hasUnread } from './unread';
import { defaultNotificationGroupKey } from '../../../shared/notification-log';

interface UnseenNotificationsState {
  keys: ReadonlySet<string>;
  setKeys: (keys: readonly string[]) => void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useUnseenNotificationsStore = create<UnseenNotificationsState>((set, get) => ({
  keys: EMPTY,
  setKeys: (keys) => {
    const prev = get().keys;
    // Same set, same identity: every subscriber of the global number re-renders
    // on a new object.
    if (keys.length === prev.size && keys.every((k) => prev.has(k))) return;
    set({ keys: keys.length ? new Set(keys) : EMPTY });
  },
}));

/**
 * The keys a server answer carries, or placeholders when it carries only the
 * number (a server older than this client): the count stays right, the union
 * with the live signals just cannot dedupe those.
 */
export function unseenKeysOf(snapshot: { unseen?: number; unseenKeys?: string[] }): string[] {
  if (Array.isArray(snapshot.unseenKeys)) return snapshot.unseenKeys;
  const n = Math.max(0, snapshot.unseen ?? 0);
  return Array.from({ length: n }, (_, i) => `unseen#${i}`);
}

/**
 * Opening a chat has something to tell the server when the chat has unread
 * messages OR an unseen notification. Reading only the unread left a chat's
 * notification lit forever when it was born after the unread had already been
 * cleared (another window, a push): the POST was skipped as a no-op.
 */
export function openingChatClearsSomething(
  unread: UnreadData,
  unseenKeys: ReadonlySet<string>,
  topicId: string,
): boolean {
  if (hasUnread(unread, topicId)) return true;
  const key = defaultNotificationGroupKey('topic', topicId);
  return !!key && unseenKeys.has(key);
}
