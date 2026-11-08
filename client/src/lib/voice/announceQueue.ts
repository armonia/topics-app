/**
 * The board's voice announcement queue — PURE, no microphone or audio in
 * here: only the rule of WHO gets announced and WHEN it collapses into a
 * summary.
 *
 * Why a queue instead of "speak as soon as the event arrives": two
 * `task:review-ready` events a second apart — it happens when the review
 * queue is drained by hand, see the postponement note on this same card —
 * would produce two overlapping voices. This module keeps ONE item "in
 * flight" at a time (the caller decides when to drain, this module only
 * decides the CONTENT of the next announcement), and if the queue grows past
 * `ROLLUP_THRESHOLD` it collapses into ONE summary instead of reading every
 * title in full — the anti-crowding behaviour the task asked for.
 */

export interface AnnounceItem {
  taskId: string;
  projectId: string;
  title: string;
  /** Text of the pending question, if the delivery IS a question. */
  questionText?: string;
}

export interface AnnounceQueueState {
  items: readonly AnnounceItem[];
}

export const EMPTY_ANNOUNCE_QUEUE: AnnounceQueueState = { items: [] };

/** Past this length, the next announcement is a rollup, not a single item. */
export const ROLLUP_THRESHOLD = 3;

/**
 * Adds an item, deduped by `taskId`: the same task re-entering review twice
 * (a second feedback round) replaces the old announcement instead of
 * doubling it in the queue.
 */
export function enqueueAnnouncement(state: AnnounceQueueState, item: AnnounceItem): AnnounceQueueState {
  const withoutDup = state.items.filter((i) => i.taskId !== item.taskId);
  return { items: [...withoutDup, item] };
}

export function removeAnnouncement(state: AnnounceQueueState, taskId: string): AnnounceQueueState {
  return { items: state.items.filter((i) => i.taskId !== taskId) };
}

/** What to say next — a single item (with its own listenable reply) or a
 *  rollup (no spoken reply expected: it names several tasks at once). */
export type NextAnnouncement =
  | { kind: 'single'; item: AnnounceItem }
  | { kind: 'rollup'; items: readonly AnnounceItem[] };

/**
 * The next announcement to make, and the queue left afterwards.
 * `null` when the queue is empty — nothing to announce.
 */
export function nextAnnouncement(state: AnnounceQueueState): { announcement: NextAnnouncement | null; rest: AnnounceQueueState } {
  if (state.items.length === 0) return { announcement: null, rest: state };
  if (state.items.length >= ROLLUP_THRESHOLD) {
    // The rollup drains the whole queue: announcing them one by one right
    // after a summary that already named them all would repeat the same
    // information twice.
    return { announcement: { kind: 'rollup', items: state.items }, rest: EMPTY_ANNOUNCE_QUEUE };
  }
  const [item, ...rest] = state.items;
  return { announcement: { kind: 'single', item }, rest: { items: rest } };
}

/** The spoken text for a single item: title, plus the question if there is one. */
export function announceText(item: AnnounceItem): string {
  const base = `Ready for review: ${item.title}.`;
  return item.questionText ? `${base} ${item.questionText}` : base;
}

/** The rollup text when the queue is too full to list every task. */
export function rollupText(items: readonly AnnounceItem[]): string {
  return `${items.length} tasks ready for review: ${items.map((i) => i.title).join(', ')}.`;
}
