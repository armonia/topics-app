/**
 * WHAT IS RUNNING RIGHT NOW, said in numbers instead of a sentence.
 *
 * The identity chip used to carry the presence phrase whole, the UI string
 * "3 al lavoro / 12 aperte". allow-italian: the quoted string is the UI text.
 * In a 240px column that sentence ate the row: the name truncated to
 * make room for words that are the same three words every time, and the only
 * part that CHANGES, the digits, arrived last and got cut first. A glyph plus a
 * digit says the same thing in a quarter of the width, and it survives the
 * column being dragged narrow.
 *
 * TWO NUMBERS, AND THEY ARE THESE TWO.
 * The tail used to hold three glyphs picked out of five candidates (working
 * sessions, sessions waiting for an answer, finished turns nobody looked at,
 * board tasks, open sessions) by a priority rule. Three digits side by side
 * read as one pile: to know WHICH number moved you had to remember the order
 * of the glyphs, and a summary you have to decode is not a summary. What is
 * left is the pair that answers the two questions the row is opened for: how
 * much is happening right now, and how much is open in here.
 *
 * NOTHING IS LOST WITH THE THREE THAT WENT.
 * The sessions parked on a question and the turns nobody has read are named,
 * one by one, in the level this row opens, and they are spelled out in the
 * tooltip of the card itself; the board tasks have a board. They were a digit
 * with no way to ask "which ones" - the level is that way.
 */

/** The two things the tail counts, each with its own glyph in the chip. */
export type SignalKind = 'working' | 'open';

export interface WorkSignal {
  kind: SignalKind;
  n: number;
}

export interface WorkCounts {
  /** Sessions that exist and are not archived. */
  openSessions: number;
  /** Sessions with an agent answering right now. */
  workingSessions: number;
}

/** Alive first, inventory last: what is happening is read before what exists. */
const ORDER: SignalKind[] = ['working', 'open'];

/**
 * The signals to draw, in reading order.
 *
 * A zero is never drawn: an absence stated with a glyph is a glyph you learn to
 * ignore, and here it would also be the widest kind of nothing. With everything
 * at zero the function returns an empty list and the chip is just your name,
 * which is the truthful shape of a quiet machine.
 */
export function workSignals(counts: WorkCounts): WorkSignal[] {
  const value: Record<SignalKind, number> = {
    working: counts.workingSessions,
    open: counts.openSessions,
  };
  return ORDER.filter((kind) => value[kind] > 0).map((kind) => ({ kind, n: value[kind] }));
}
