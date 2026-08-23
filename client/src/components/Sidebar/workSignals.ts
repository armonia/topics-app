/**
 * WHAT IS RUNNING RIGHT NOW, said in numbers instead of a sentence.
 *
 * The identity chip used to carry the presence phrase whole ("3 al lavoro · 12
 * aperte"). In a 240px column that sentence ate the row: the name truncated to
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
 * first is what is alive (working). So there are two orders: `PRIORITA` decides
 * who stays, `ORDINE` decides where they sit. Merging them would mean either
 * dropping the open-session count, which is the one number always worth having,
 * or reading the row right to left.
 */

/** The five things that can appear, each with its own glyph in the chip. */
export type TipoSegnale = 'working' | 'awaitingInput' | 'done' | 'tasks' | 'open';

export interface SegnaleLavoro {
  tipo: TipoSegnale;
  n: number;
}

export interface ContiLavoro {
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
export const MAX_SEGNALI = 3;

/** Who survives the cut, most urgent first. `open` sits above `tasks` because
 *  "how much is going on in here" is the question the chip answers even when
 *  nothing is running. */
const PRIORITA: TipoSegnale[] = ['working', 'awaitingInput', 'done', 'open', 'tasks'];

/** Who sits where, once the survivors are known: alive first, inventory last. */
const ORDINE: TipoSegnale[] = ['working', 'awaitingInput', 'done', 'tasks', 'open'];

/**
 * The signals to draw, already cut and already sorted.
 *
 * A zero is never drawn: an absence stated with a glyph is a glyph you learn to
 * ignore, and here it would also be the widest kind of nothing. With everything
 * at zero the function returns an empty list and the chip is just your name,
 * which is the truthful shape of a quiet machine.
 */
export function segnaliLavoro(conti: ContiLavoro, max: number = MAX_SEGNALI): SegnaleLavoro[] {
  const valore: Record<TipoSegnale, number> = {
    working: conti.workingSessions,
    awaitingInput: conti.awaitingInput,
    done: conti.awaitingDone,
    tasks: conti.activeTasks,
    open: conti.openSessions,
  };
  const scelti = new Set<TipoSegnale>();
  for (const tipo of PRIORITA) {
    if (scelti.size >= max) break;
    if (valore[tipo] > 0) scelti.add(tipo);
  }
  return ORDINE.filter((t) => scelti.has(t)).map((tipo) => ({ tipo, n: valore[tipo] }));
}
