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
 * (`subjects`) so each window drops its own.
 */
import type { UnreadData } from "../shared/types";
import type { OutboundMessage } from "../shared/ws-outbound";
import { defaultNotificationGroupKey } from "../shared/notification-log";
import {
  groupKeysOfNotifications,
  markNotificationsSeen,
  markTargetNotificationsSeen,
  unseenSnapshot,
  type UnseenSnapshot,
} from "./db/notification-log";

export interface SubjectSeenDeps {
  loadUnread: () => UnreadData;
  /** Upserts only the given rows (`AppContext.saveUnreadEntries`). */
  saveUnreadEntries: (entries: UnreadData) => void;
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
  const changed: UnreadData = {};
  for (const id of topicIds) {
    if ((unread[id]?.unreadCount ?? 0) <= 0) continue;
    changed[id] = { lastReadAt: now, unreadCount: 0 };
    cleared.push(id);
  }
  if (!cleared.length) return cleared;
  deps.saveUnreadEntries(changed);
  for (const topicId of cleared) {
    deps.broadcastToAll({ type: "unread:updated", topicId, unreadCount: 0 } as OutboundMessage);
  }
  return cleared;
}

/**
 * Opening a chat: its unread goes to zero and so do its notification rows, and
 * every window drops its marks for the chat.
 *
 * The rows are cleared even when the unread counter was already zero. The old
 * read route returned early on a zero counter, which left the bell lit for a
 * chat whose messages had been read elsewhere.
 *
 * `doneMark`: the window that opened the chat cleared its 'done' mark. That
 * mark lives in the windows and nowhere here, so with nothing of its own to
 * clear the door announces anyway: the frame is the only way the others drop it.
 */
export function markTopicSeen(
  deps: SubjectSeenDeps,
  topicId: string,
  opts: { doneMark?: boolean } = {},
): { unreadCleared: boolean; rowsSeen: number } {
  const unreadCleared = resetUnread(deps, () => [topicId]).length > 0;
  const rowsSeen = markTargetNotificationsSeen("topic", topicId);
  // Announced whenever the chat was seen, not only when it had rows: every
  // window keeps its own 'done' mark for it, and a finished chat's reply is
  // usually unread with no row (muted, Do Not Disturb, a hidden window).
  if (unreadCleared || rowsSeen > 0 || opts.doneMark) {
    const subject = defaultNotificationGroupKey("topic", topicId);
    deps.broadcastToAll({
      type: "notification:seen",
      ...unseenSnapshot(),
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
export function markNotificationRowsSeen(deps: SubjectSeenDeps, ids: string[]): UnseenSnapshot {
  const subjects = groupKeysOfNotifications(ids);
  markNotificationsSeen({ ids });
  const topicIds = subjects.map(topicIdOfGroupKey).filter((id): id is string => !!id);
  resetUnread(deps, () => topicIds);
  const snapshot = unseenSnapshot();
  deps.broadcastToAll({ type: "notification:seen", ...snapshot, subjects } as OutboundMessage);
  return snapshot;
}

/** How many listed subjects one mark all may name: the panel lists tens, a
 *  runaway body must not become a runaway broadcast. */
const MAX_LISTED_SUBJECTS = 500;

/**
 * Opening the panel, i.e. MARK ALL: every row up to `upTo`, and every subject
 * the panel LISTED (`subjects`: the chats and terminals under "Waiting for
 * you"), nothing else.
 *
 * It used to reset every chat still counting unread, listed or not. That
 * cleared chats the panel had never shown: a muted chat (MUTE-01, no banner
 * so no row) or one silenced by Do Not Disturb, whose messages landed after
 * the list was read. A chat with a row was spared by the row newer than
 * `upTo`; a chat with no row had nothing to spare it.
 *
 * A listed subject with a row that is STILL unseen, i.e. newer than `upTo`,
 * stays lit: a notification that arrived after the list was read has not been
 * seen. The frame names exactly the subjects this call cleared, so each
 * window drops those marks (terminal "finished", chat "done") and those dots.
 */
export function markAllNotificationsSeen(
  deps: SubjectSeenDeps,
  opts: { upTo?: string; subjects?: readonly string[] },
): UnseenSnapshot {
  const before = unseenSnapshot().unseenKeys;
  if (opts.upTo) markNotificationsSeen({ upTo: opts.upTo });
  const snapshot = unseenSnapshot();
  const stillUnseen = new Set(snapshot.unseenKeys);
  const rowSubjects = before.filter((key) => !stillUnseen.has(key));
  const listed = (opts.subjects ?? [])
    .filter((key) => typeof key === "string" && !!key && !stillUnseen.has(key))
    .slice(0, MAX_LISTED_SUBJECTS);
  const subjects = [...new Set([...rowSubjects, ...listed])];
  const topicIds = subjects.map(topicIdOfGroupKey).filter((id): id is string => !!id);
  resetUnread(deps, () => topicIds);
  if (subjects.length) deps.broadcastToAll({ type: "notification:seen", ...snapshot, subjects } as OutboundMessage);
  return snapshot;
}
