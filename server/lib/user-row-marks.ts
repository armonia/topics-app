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
 * never wrote, in a bubble with an "edit" button on it. Measured on the live
 * DB: 411 rows opening with "You are the exclusive owner of task" and 1,033
 * with "previous turn on this task was interrupted", every one with a NULL
 * author. `dispatched: true` already travelled with the request, but it stopped
 * at the push trigger and never reached the table.
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
  if (origin.dispatched === true) blocks.push({ kind: "dispatched-envelope" });
  return blocks.length ? blocks : undefined;
}
