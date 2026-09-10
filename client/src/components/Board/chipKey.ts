/**
 * Which chip a card shows, when the dispatch state alone is not the whole truth.
 *
 * `delivered` means "the agent handed the work over: approve or reject". A card
 * the reaper pushed into review after burning every attempt carries the SAME
 * state, so on the board the two look identical, and you only find out which
 * one you are holding after opening the card and reading the thread. Measured
 * on `a035f945`: four turns, no summary, the agent never moved it itself, and a
 * green "consegnato" chip on the front.
 *
 * The field that knows is `deliveredBy`: the store writes `'system'` exactly
 * when nobody handed anything over. So a system delivery gets its own chip,
 * amber and not green, and the review column stops mixing "look at this work"
 * with "this run died".
 *
 * Pure and separate from the component for the usual reason: a rule inside a
 * render body is a rule that can only be checked by rendering.
 */
export function chipKey(state: string, deliveredBy?: string | null, hasWork = true): string {
  if (state !== 'delivered') return state;
  // Nothing produced beats who moved it. A card with no branch, no commit and
  // no changed file has nothing to open, and that is true whether the agent
  // handed it over or the reaper pushed it: measured on the live board, 17 of
  // 24 cards in review had none of the three, and 15 of them wore the green
  // "consegnato". Green there is a promise the card cannot keep.
  if (!hasWork) return 'delivered_empty';
  return deliveredBy === 'system' ? 'delivered_by_system' : 'delivered';
}

/**
 * HOW MANY FILES THE "no commit" CHIP HAS TO NAME, and 0 means "say nothing".
 *
 * The chip said "branch with no commit" over a card that had produced nothing
 * and over one holding two finished files in its worktree, and those are the
 * two opposite decisions: a re-dispatch against one line asking for a commit.
 * The count belongs HERE, in the chip that already talks about the git side,
 * and not as one more note in the thread.
 *
 * `null` (never measured) reads as 0: the chip falls back to the sentence it
 * has always shown instead of inventing a zero.
 *
 * Pure and out of the render body for the usual reason: a rule inside JSX is a
 * rule only a rendered pixel can check.
 */
export function uncommittedChipCount(
  uncommitted: number | null | undefined,
  senzaCommit: boolean,
): number {
  if (!senzaCommit) return 0;
  const n = uncommitted ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The three columns that say a run left something behind. */
export function taskHasWork(t: { deliveryBranch?: string | null; deliveryCommit?: string | null; deliveryFilesChanged?: number | null }): boolean {
  return Boolean(t.deliveryBranch || t.deliveryCommit || (t.deliveryFilesChanged ?? 0) > 0);
}

/**
 * WHERE THE WORDS YOU JUST TYPED GOT TO, when two sources answer at once.
 *
 * Two things talk about the same bubble, and they answer different questions:
 *
 *  · the DERIVED state (`taskTimeline.deliveryOf`, KANBAN-74) reads the
 *    envelopes at every read and knows whether the card still owes a turn —
 *    `delivered` when an envelope named this row, `pending` while a card in
 *    `todo`/`in_progress` has not carried it yet;
 *  · the RECEIPT is what the POST answered when you pressed send, and it is
 *    about that instant only: `queued`/`answered` when the route handed the
 *    words to a live agent, `note`/`saved` when it did not.
 *
 * The receipt used to win, and on a card in `todo` that is a lie with a
 * measured shape: the comment route only resumes an agent for a card in
 * `review` or `in_progress`, so a steer typed on a queued card came back as
 * `note` and the bubble said "Note saved. No agent response requested." — the
 * wording of the QUIET button, under words the person had just sent to the
 * agent. Nothing ever took it back either: the drawer clears a receipt after
 * revalidation only when it says `queued`.
 *
 * So the derivation is the authority, and the receipt speaks in the two places
 * where the derivation cannot: where it is silent, and where the route did
 * something this instant that no envelope shows yet (`answered` unblocks a
 * routed question mid-turn, `queued` fires the resume). "Not handed over now"
 * never overrules "this card still owes a turn".
 */
export type CommentChip = 'delivered' | 'answered' | 'queued' | 'pending' | 'note' | 'saved';

export function commentChip(
  derived: 'delivered' | 'pending' | undefined,
  receipt: CommentChip | undefined,
): CommentChip | undefined {
  // An envelope named this row: evidence in the transcript, and it outlives
  // every receipt.
  if (derived === 'delivered') return 'delivered';
  // The route just moved the words, and the transcript cannot show it yet.
  if (receipt === 'answered' || receipt === 'queued') return receipt;
  return derived ?? receipt;
}

/**
 * The testid says WHAT THE CHIP SAYS, never which source won.
 *
 * `task-comment-receipt` used to mean "a receipt exists", so the same id
 * covered "delivered" and "note" and a test could not tell the two apart.
 * Three words, three ids.
 */
export function commentChipTestId(chip: CommentChip): string {
  if (chip === 'delivered' || chip === 'answered') return 'task-comment-delivered';
  if (chip === 'note' || chip === 'saved') return 'task-comment-receipt';
  return 'task-comment-queued';
}
