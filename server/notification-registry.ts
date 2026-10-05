/**
 * THE ONE DOOR of the notification log, server side.
 *
 * Underneath sits `db/notification-log.ts` (the table and its queries). Here
 * sits the one thing every writer must do and nobody may forget: the gate of
 * the ARCHIVED topics. Written in one place because there are three writers
 * (the attention store, the system notices, the public route), and a rule
 * copied three times drifts at the first change.
 *
 * No frame leaves from here: the attention store tells the windows, inside the
 * `attention:updated` of the transition that wrote the row, or on
 * `attention:history` for a row no transition wrote (notifications-redesign,
 * tasks.md 6.2).
 *
 * The topic lookup is INJECTED at bootstrap, as for `configureAttentionStore`:
 * the module keeps no dependency on the app context and the tests mount it
 * with one fake function.
 */

import { recordNotification } from "./db/notification-log";
import type { NotificationRecordInput, NotificationRow } from "../shared/notification-log";

let topicArchived: ((topicId: string) => boolean) | null = null;

export function configureNotificationRegistry(opts: {
  /**
   * Is this topic archived? REQUIRED on purpose. The sessions of archived
   * topics kept notifying for months after the chat had left the interface:
   * the log must not become the place where that noise piles up forever. A
   * permissive default would bring the defect back, silently, the day the
   * wiring gets lost.
   */
  isTopicArchived: (topicId: string) => boolean;
}): void {
  topicArchived = opts.isTopicArchived;
}

/** Tests only. */
export function __resetNotificationRegistry(): void {
  topicArchived = null;
}

/**
 * Write the row. `null` when it was not written: a duplicate inside the dedup
 * window, an archived topic, or a write error.
 *
 * The return value is NOT decorative: only a new row travels in the store's
 * frames. It is also the defence against the boot trap: if something replays
 * old events at start, the dedup recognises them and the history does not
 * present them as new.
 */
export function recordNotificationRow(input: NotificationRecordInput): NotificationRow | null {
  if (input.targetKind === "topic" && input.targetId && topicArchived?.(input.targetId)) return null;
  return recordNotification(input);
}
