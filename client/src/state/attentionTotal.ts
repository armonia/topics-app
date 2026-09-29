/**
 * The ONE number Topics paints on the operating system: the dock badge, the
 * macOS menu-bar tray glyph, and the PWA Badging API all project the value this
 * module computes, and nothing else computes it.
 *
 * One criterion: HOW MANY THINGS ARE ASKING A HUMAN FOR SOMETHING. Things, not
 * messages: a chat with 39 unread messages is ONE (its row keeps showing 39).
 * That is
 *   - every non-archived chat that is unread or waiting for the user
 *     (`topicAttentionCount`, the same helper each sidebar row and tab uses);
 *   - every claude-code terminal whose turn finished and has not been opened
 *     (`terminalAttentionCount`, again the per-row helper);
 *   - every window-local pane badge (`paneCounts`, the notification layer's
 *     `extraCounts`, which the sidebar utility rows read through the same map);
 *   - every board card waiting for a decision (`trayBoardAttention`);
 *   - every subject with a notification not yet seen (the registry's unseen
 *     keys), so the bell and the dock count THE SAME subjects: a card in review
 *     with no notification row, or a chat waiting for you whose rows were all
 *     seen, used to light the dock while the panel said "No notifications".
 *
 * Each subject once: a chat with unread messages AND an unseen notification is
 * one thing, keyed as the registry keys it (`topic:<id>`, `task:<id>`, ...).
 *
 * Work that runs on its own asks nothing and does not count. An ARCHIVED topic
 * never counts: it has no row to open, so nothing could ever switch it off.
 *
 * Pure, no React, no I/O: the parity test computes its expectation from the very
 * per-row helpers the sidebar calls, so a criterion that changes on one surface
 * and not the other turns the test red instead of quietly drifting.
 */
import type { Topic } from '../types';
import { globalAttentionTopicIds } from './signals';
import type { TrayGroup } from '../../../shared/tray-board';
import { defaultNotificationGroupKey, terminalNotificationGroupKey } from '../../../shared/notification-log';

export interface ChromeAttentionInput {
  topics: Record<string, Topic>;
  unread: Record<string, { unreadCount: number } | undefined>;
  claudeAttentionTopics: Set<string>;
  terminalFinishedIds: Set<string>;
  boardGroups: readonly TrayGroup[];
  paneCounts: ReadonlyMap<string, number>;
  /** The registry's unseen subjects (`useUnseenNotificationsStore`). */
  unseenNotificationKeys?: ReadonlySet<string>;
}

export type ChromeSubjectKind = 'chat' | 'terminal' | 'pane' | 'card' | 'notification';

/** One thing asking a human for something, under the registry's key for it. */
export interface ChromeSubject {
  key: string;
  kind: ChromeSubjectKind;
  id: string;
  /** Cards only: the title the board list carries. */
  title?: string;
}

/** How many window-local panes carry a badge (agents pane, session viewer, ...):
 *  a pane is one subject, whatever its count, like a chat. */
export function paneAttentionTotal(paneCounts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const n of paneCounts.values()) if (n > 0) sum += 1;
  return sum;
}

/**
 * WHO the one number counts, each once. The notifications panel lists the
 * non-notification entries under "Waiting for you", so nothing the dock counts
 * is missing from the panel.
 */
export function chromeAttentionSubjects(input: ChromeAttentionInput): ChromeSubject[] {
  const out: ChromeSubject[] = [];
  const seen = new Set<string>();
  const add = (subject: ChromeSubject) => {
    if (seen.has(subject.key)) return;
    seen.add(subject.key);
    out.push(subject);
  };
  for (const id of globalAttentionTopicIds(input.topics, input.unread, input.claudeAttentionTopics)) {
    add({ key: defaultNotificationGroupKey('topic', id) ?? `topic:${id}`, kind: 'chat', id });
  }
  for (const id of input.terminalFinishedIds) add({ key: terminalNotificationGroupKey(id), kind: 'terminal', id });
  for (const [id, n] of input.paneCounts) if (n > 0) add({ key: `pane:${id}`, kind: 'pane', id });
  const review = input.boardGroups.find((g) => g.status === 'review');
  if (review) {
    for (const row of review.rows) {
      add({ key: defaultNotificationGroupKey('task', row.id) ?? `task:${row.id}`, kind: 'card', id: row.id, title: row.title });
    }
    // A group cut to its first rows still counts every card in it.
    for (let i = review.rows.length; i < review.count; i++) add({ key: `task#${i}`, kind: 'card', id: '' });
  }
  for (const key of input.unseenNotificationKeys ?? []) add({ key, kind: 'notification', id: key });
  return out;
}

/**
 * Chats + terminals + pane badges + board cards in review + unseen
 * notifications, each subject once. Every OS surface and the bell read THIS.
 */
export function chromeAttentionTotal(input: ChromeAttentionInput): number {
  return chromeAttentionSubjects(input).length;
}

/**
 * What the notifications panel lists under "Waiting for you": every subject the
 * number counts that the history below does not already show with an unseen
 * dot. Without it a card in review, or a chat waiting for an answer, lit the
 * dock while the panel said "No notifications".
 */
export function waitingSubjects(
  subjects: readonly ChromeSubject[],
  unseenNotificationKeys: ReadonlySet<string>,
): ChromeSubject[] {
  return subjects.filter((s) => s.kind !== 'notification' && !!s.id && !unseenNotificationKeys.has(s.key));
}
