/**
 * ONE SEEN-STATE PER SUBJECT, server side: the single door every "I have seen
 * it" goes through.
 *
 * A chat had two counters of the same fact. `unread` (the row badge, the tab
 * badge, the dock) was reset only by opening the chat; `notification_log` (the
 * bell) was cleared by opening the chat AND by the history panel. The panel
 * therefore cleared the bell and left everything else lit: measured on
 * 2026-09-29, 0 unseen rows against 132 unread messages on 6 chats, and a dock
 * showing 133 while the panel said there was nothing.
 *
 * Here the three gestures become one write each:
 *   - opening a chat                     -> `markTopicSeen`
 *   - clicking rows in the panel         -> `markNotificationRowsSeen`
 *   - opening the panel (the "mark all") -> `markAllNotificationsSeen`
 * and every one of them resets the chat's unread AND its rows, and tells every
 * window through the frames it already listens to (`unread:updated`,
 * `notification:seen`).
 *
 * Terminal "finished" marks and chat "done" marks live in each window's memory,
 * not here: the `notification:seen` frame names the subjects it cleared
 * (`subjects`, or everything but `allExcept`) so each window drops its own.
 */
import type { UnreadData } from "../shared/types";
import type { OutboundMessage } from "../shared/ws-outbound";
import { defaultNotificationGroupKey } from "../shared/notification-log";
import {
  countUnseenNotifications,
  groupKeysOfNotifications,
  markNotificationsSeen,
  markTargetNotificationsSeen,
  unseenNotificationGroupKeys,
} from "./db/notification-log";

export interface SubjectSeenDeps {
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  broadcastToAll: (message: OutboundMessage) => void;
}

const TOPIC_GROUP_PREFIX = "topic:";

/** `topic:<id>` -> `<id>`; anything else (a task, a terminal) -> null. */
export function topicIdOfGroupKey(groupKey: string): string | null {
  return groupKey.startsWith(TOPIC_GROUP_PREFIX) ? groupKey.slice(TOPIC_GROUP_PREFIX.length) || null : null;
}

/**
 * Reset the unread counter of these topics, in ONE write, and announce each
 * reset. Only topics whose counter is above zero are touched: a no-op must stay
 * silent, because every `unread:updated` wakes every connected client.
 */
function resetUnread(deps: SubjectSeenDeps, pick: (unread: UnreadData) => Iterable<string>): string[] {
  const unread = deps.loadUnread();
  const topicIds = pick(unread);
  const now = new Date().toISOString();
  const cleared: string[] = [];
  for (const id of topicIds) {
    if ((unread[id]?.unreadCount ?? 0) <= 0) continue;
    unread[id] = { lastReadAt: now, unreadCount: 0 };
    cleared.push(id);
  }
  if (!cleared.length) return cleared;
  deps.saveUnread(unread);
  for (const topicId of cleared) {
    deps.broadcastToAll({ type: "unread:updated", topicId, unreadCount: 0 } as OutboundMessage);
  }
  return cleared;
}

/**
 * Opening a chat: its unread goes to zero and so do its notification rows.
 *
 * The rows are cleared even when the unread counter was already zero. The old
 * read route returned early on a zero counter, which left the bell lit for a
 * chat whose messages had been read elsewhere.
 */
export function markTopicSeen(deps: SubjectSeenDeps, topicId: string): { unreadCleared: boolean; rowsSeen: number } {
  const unreadCleared = resetUnread(deps, () => [topicId]).length > 0;
  const rowsSeen = markTargetNotificationsSeen("topic", topicId);
  if (rowsSeen > 0) {
    const subject = defaultNotificationGroupKey("topic", topicId);
    deps.broadcastToAll({
      type: "notification:seen",
      unseen: countUnseenNotifications(),
      ...(subject ? { subjects: [subject] } : {}),
    } as OutboundMessage);
  }
  return { unreadCleared, rowsSeen };
}

/**
 * Rows clicked in the panel: the rows, their group, and the SUBJECT behind
 * them. A chat's notification seen here is the chat seen, so its unread goes
 * to zero with it.
 */
export function markNotificationRowsSeen(deps: SubjectSeenDeps, ids: string[]): number {
  const subjects = groupKeysOfNotifications(ids);
  markNotificationsSeen({ ids });
  const topicIds = subjects.map(topicIdOfGroupKey).filter((id): id is string => !!id);
  resetUnread(deps, () => topicIds);
  const unseen = countUnseenNotifications();
  deps.broadcastToAll({ type: "notification:seen", unseen, subjects } as OutboundMessage);
  return unseen;
}

/**
 * Opening the panel, i.e. MARK ALL: every row up to `upTo`, and every chat
 * that is still counting unread messages, whether or not it has a row left.
 *
 * The second half is the one that clears what the first cannot reach: chats
 * whose rows were seen long ago (by the panel, before this door existed) while
 * their unread kept counting. The only chats spared are those with a row that
 * is STILL unseen, i.e. newer than `upTo`: a notification that arrived after
 * the list was read has not been seen, and it keeps its chat lit with it.
 */
export function markAllNotificationsSeen(deps: SubjectSeenDeps, upTo: string): number {
  markNotificationsSeen({ upTo });
  const stillUnseen = unseenNotificationGroupKeys();
  const spared = new Set(stillUnseen.map(topicIdOfGroupKey).filter((id): id is string => !!id));
  resetUnread(deps, (unread) => Object.keys(unread).filter((id) => !spared.has(id)));
  const unseen = countUnseenNotifications();
  deps.broadcastToAll({ type: "notification:seen", unseen, allExcept: stillUnseen } as OutboundMessage);
  return unseen;
}
