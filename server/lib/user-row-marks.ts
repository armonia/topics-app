/**
 * WHAT MARKS A `user` ROW AS SOMETHING NOBODY TYPED.
 *
 * Two turns reach `POST /api/chat` wearing the person's role without being the
 * person: the goal continuation (a goal still open at the end of a turn buys
 * the next one, `services/goal-loop.ts`) and the dispatcher's envelope (the
 * kickoff, the resume, the nudge a board task starts with). Both HAVE to be
 * `user` rows, because that is the only role a provider answers.
 *
 * Without a mark on the row the transcript shows the human saying words they
 * never wrote, in a bubble with an "edit" button on it. Measured on the live DB
 * on 2026-09-04: 2,301 unmarked `user` rows opening with one of the four
 * dispatcher envelopes, 437 of them with "LAST TURN on". `dispatched: true`
 * already travelled with the request, but it stopped at the push trigger and
 * never reached the table. The rows already written are marked by
 * `20260904190854-mark-dispatched-envelopes.sql`, which is the only reader
 * allowed to recognise an envelope by its text: everything else reads the
 * block.
 *
 * The rule lives here rather than inline in the route for the reason every
 * decision in that file eventually finds: the route is where it is APPLIED, not
 * where it is decided, and here it has a test that needs no HTTP.
 */

import type { ContentBlock } from "../types";

export interface UserRowOrigin {
  /** The consecutive continuation number, when the goal loop bought this turn. */
  goalNudge?: unknown;
  /** True when the board drives this turn (`runHeadlessTurn`). */
  dispatched?: boolean;
  /** The card comments this envelope delivers, when it is a resume. */
  commentIds?: unknown;
}

/**
 * The blocks to write ON the row, or `undefined` when the person really did
 * type it. `undefined` and not an empty array: an empty `blocks` column would
 * be a claim ("we looked, there is nothing") where the truth is that the row
 * needs no marking at all, and every row written before this existed carries
 * NULL there.
 */
export function userRowMarks(origin: UserRowOrigin): ContentBlock[] | undefined {
  const blocks: ContentBlock[] = [];
  // A number, and a positive one: `goalNudge: 0` is the loop saying it did not
  // buy anything, and marking that row would be inventing a continuation.
  if (typeof origin.goalNudge === "number" && origin.goalNudge > 0) {
    blocks.push({ kind: "goal-nudge", attempt: Math.floor(origin.goalNudge) });
  }
  if (origin.dispatched === true) {
    // Ids only on a row that IS an envelope, and only when there are any: a
    // list of comments on a row nobody dispatched would be an anchor pointing
    // at words this turn never carried, and an empty list would claim the
    // resume delivered nothing when a kickoff simply has nothing to deliver.
    const ids = Array.isArray(origin.commentIds)
      ? origin.commentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    blocks.push(ids.length ? { kind: "dispatched-envelope", commentIds: ids } : { kind: "dispatched-envelope" });
  }
  return blocks.length ? blocks : undefined;
}
