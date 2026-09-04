/**
 * A CLOSED CARD DOES NOT WEAR A FAILURE.
 *
 * `dispatchError` is the reason the LAST turn did not get there ("the turn
 * ended without reaching review after 2 attempts"). With no live chip on the
 * row it is the only thing left to say, so both the board card and the drawer
 * drew a rose 'stopped' badge out of it. Neither looked at the status, and
 * nothing on the server cleared the field when a card was approved: 44 cards
 * sat in Done wearing a red badge for a turn that ended weeks earlier and was
 * then finished by hand.
 *
 * `taskChoices.ts` already draws the same line one row lower (`if (task.status
 * === 'done') return null`): a done card offers no action, so it cannot be
 * announcing a state you could act on either.
 *
 * The rule lives here, on its own, because it was written TWICE - once in
 * `Card.tsx`, once in `TaskDetail.tsx` - and two copies of a rule are two
 * rules the day one of them is fixed.
 */

export interface StoppedChipTask {
  status: string;
  dispatchState?: string | null;
  dispatchError?: string | null;
}

/** Does the rose 'stopped' badge belong on this card? */
export function showsStoppedChip(task: StoppedChipTask): boolean {
  if (task.status === 'done') return false;
  return !task.dispatchState && !!task.dispatchError;
}
