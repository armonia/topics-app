/**
 * Whether the "the session died, I am resuming the task" note still says
 * something true.
 *
 * WHAT WENT WRONG. `buryDeadRun` writes that line and only then calls
 * `onTurnEnd`, which is what actually decides the card's fate. When the retries
 * were already spent, the card had been delivered to review minutes earlier and
 * a late-dying process still posted "I am resuming the task instead of leaving
 * it stuck on 'working'" onto a card sitting in review. Measured on
 * `a035f945`: three copies of that sentence, one of them AFTER the
 * `in_progress → review` transition, in a thread that already carried thirteen
 * service notes.
 *
 * It is the same defect the delivery path learned the hard way (see the comment
 * on `deliverToReviewBySystem` about announcing "I moved it to review" before
 * knowing where the card lands): the reason for a turn ending is known here,
 * the NEXT MOVE is not. A sentence that predicts it is wrong exactly when the
 * card is being read by a human.
 *
 * So the note is written only while the card is still working. Everything else
 * `buryDeadRun` does — releasing the slot, booking usage, `onTurnEnd` — happens
 * regardless: this gates the sentence, never the bookkeeping.
 *
 * A pure predicate and not an `if` inline, for the reason the rest of this
 * codebase keeps giving: a rule buried inside a function that owns timers and a
 * process probe is a rule no test can reach.
 */
export function annunciaRipresa(status: string | null | undefined): boolean {
  return status === "in_progress";
}

/**
 * The opening of that note, shared by the writer and by the store that empties
 * the slot before writing it again.
 *
 * A process can die more than once on the same card, and each death used to add
 * another identical paragraph: three copies on `a035f945`. The sentence
 * describes a CONDITION, not an event worth counting, so it belongs in one slot.
 * The store matches on this prefix (`sostituisce`), which is why it must come
 * from here and never be retyped at the call site.
 */
export const NOTA_SESSIONE_MORTA = "La sessione dell'agent è morta";
