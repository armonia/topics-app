/**
 * WHAT THE BOARD FEED DOES NOT CARRY.
 *
 * `GET /api/all-boards/tasks` is re-read by every open window, and every field
 * of a Task rides on every card of it. These are the fields that no code under
 * `client/src` reads off a task (2026-10-08: a word search over the client,
 * tests and the landing demo aside, finds each of them only in the `BoardTask`
 * declaration, if at all). They are dispatcher bookkeeping (`dispatchAttempts`,
 * `dispatchDeferredUntil`, `dispatchWeight`, the three `wait*`), audit identity
 * of a delegated run (the ids; the NAMES, which the card shows, stay), and
 * stamps nobody draws. On 150 cards they were 27 KB of 259 KB.
 *
 * Only the FEED drops them. `svc.get`, the project board and the server's own
 * readers keep the whole Task, and so does every `task:updated` frame on the
 * wire: the store of the feed passes frames and local patches through
 * `toFeedTask` too (`client/src/lib/boardTasksStore.ts`), so a row it absorbed
 * has the same keys as the row the next read brings back, and an unchanged
 * board stays an unchanged board.
 *
 * ADD A READER, TAKE THE FIELD OUT OF THIS LIST. `tests/unit/board-feed-fields.test.ts`
 * fails while a field listed here is read anywhere in `client/src`.
 */
export const FEED_OMITTED_TASK_FIELDS = [
  "chatId",
  "checksCommit",
  "claudeTaskId",
  "delegatedStartCapabilityId",
  "deployCommandAtPropose",
  "dispatchAttempts",
  "dispatchDeferredUntil",
  "dispatchWeight",
  "doneActor",
  "dueDate",
  "landingCheckedAt",
  "modelEffort",
  "previewRejected",
  "runInitiatorDeviceId",
  "runInitiatorPersonId",
  "urlProbeCheckedAt",
  "waitReason",
  "waitSince",
  "waitStreak",
] as const;

export type FeedOmittedTaskField = (typeof FEED_OMITTED_TASK_FIELDS)[number];

const OMITTED = new Set<string>(FEED_OMITTED_TASK_FIELDS);

/** The task as the board feed carries it: the same object minus the fields above. */
export function toFeedTask<T extends object>(task: T): Omit<T, FeedOmittedTaskField> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(task)) {
    if (!OMITTED.has(key)) out[key] = (task as Record<string, unknown>)[key];
  }
  return out as Omit<T, FeedOmittedTaskField>;
}
