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
 * ONE PLACE DECIDES WHAT IS WORTH A SLOT.
 * Five things could be counted (working sessions, sessions waiting for an
 * answer, finished turns nobody looked at, board tasks, open sessions) and the
 * chip has room for three. Which three is a rule, not a taste, so it lives here
 * as a pure function with its own test, instead of being a chain of `&&` inside
 * the JSX where nobody can check it.
 *
 * THE ORDER OF THE CUT IS NOT THE ORDER ON SCREEN.
 * What gets dropped first is the least urgent (board tasks), but what is READ
 * first is what is alive (working). So there are two orders: `PRIORITY` decides
 * who stays, `ORDER` decides where they sit. Merging them would mean either
 * dropping the open-session count, which is the one number always worth having,
 * or reading the row right to left.
 */

/** The five things that can appear, each with its own glyph in the chip. */
export type SignalKind = 'working' | 'awaitingInput' | 'done' | 'tasks' | 'open';

export interface WorkSignal {
  kind: SignalKind;
  n: number;
}

export interface WorkCounts {
  /** Sessions that exist and are not archived. */
  openSessions: number;
  /** Sessions with an agent answering right now. */
  workingSessions: number;
  /** Board tasks being executed right now. */
  activeTasks: number;
  /** Sessions parked on a question for you. */
  awaitingInput: number;
  /** Turns that ended and nobody has looked at yet. */
  awaitingDone: number;
}

/** How many glyphs the chip can hold before it stops being a chip. Three is
 *  what fits next to a name in a sidebar dragged to its usual width. */
export const MAX_SIGNALS = 3;

/** Who survives the cut, most urgent first. `open` sits above `tasks` because
 *  "how much is going on in here" is the question the chip answers even when
 *  nothing is running. */
const PRIORITY: SignalKind[] = ['working', 'awaitingInput', 'done', 'open', 'tasks'];

/** Who sits where, once the survivors are known: alive first, inventory last. */
const ORDER: SignalKind[] = ['working', 'awaitingInput', 'done', 'tasks', 'open'];

/**
 * The signals to draw, already cut and already sorted.
 *
 * A zero is never drawn: an absence stated with a glyph is a glyph you learn to
 * ignore, and here it would also be the widest kind of nothing. With everything
 * at zero the function returns an empty list and the chip is just your name,
 * which is the truthful shape of a quiet machine.
 */
export function workSignals(counts: WorkCounts, max: number = MAX_SIGNALS): WorkSignal[] {
  const value: Record<SignalKind, number> = {
    working: counts.workingSessions,
    awaitingInput: counts.awaitingInput,
    done: counts.awaitingDone,
    tasks: counts.activeTasks,
    open: counts.openSessions,
  };
  const chosen = new Set<SignalKind>();
  for (const kind of PRIORITY) {
    if (chosen.size >= max) break;
    if (value[kind] > 0) chosen.add(kind);
  }
  return ORDER.filter((t) => chosen.has(t)).map((kind) => ({ kind, n: value[kind] }));
}
