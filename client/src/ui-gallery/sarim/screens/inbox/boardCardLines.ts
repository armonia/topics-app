/**
 * What a kanban card writes under its title, decided once per card so that every
 * fact appears a single time. Pure: plain strings in, three yes/no out, so the
 * rule can be tried on real cards without the world around it.
 * allow-italian: quotes the words on screen («verifica:» and the step lines)
 */

/** Light stemming: lower case, no accents, the first five letters, so «contratto» and «contratti» meet. */
const stem = (w: string): string => w.slice(0, 5);

/** The words that carry meaning in a line: four letters or more, stemmed. */
export function significantWords(text: string): Set<string> {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return new Set(plain.split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map(stem));
}

/** The share of the significant words of `line` that `other` already has (0 when the line has none). */
export function shareOfWords(line: string, other: string): number {
  const mine = significantWords(line);
  if (mine.size === 0) return 0;
  const theirs = significantWords(other);
  let shared = 0;
  for (const w of mine) if (theirs.has(w)) shared += 1;
  return shared / mine.size;
}

/** A line is «said again» when a third of its words, or more, are already in the other. */
const REPEAT_SHARE = 1 / 3;

export interface BoardCardFacts {
  /** The column the card stands in. */
  stage: string;
  /** The title of the step of the flow it is at. */
  step: string;
  /** Whether the step is done by the one who has the card (the same agent or person). */
  stepIsWorkers: boolean;
  /** The red reason, when the card is blocked on something outside it. */
  blockedReason?: string;
  /** What the one who has the card is doing. */
  doing: string;
  /** Whether the checker is the one who has the card. */
  reviewerIsWorker: boolean;
}

export interface BoardCardLines {
  /** The line of the step of the flow. */
  step: boolean;
  /** What the worker is doing, under the worker's name (the name and the time stay). */
  doing: boolean;
  /** The line of the checker. */
  reviewer: boolean;
}

/** The stages in which the checker is the next to act: before them the checker is a future fact, not this card's. */
const CHECKING = new Set(['verifica', 'approvazione']);

/**
 * A stopped card (red reason) says why in the reason alone: no step, no activity
 * of the worker. A card on its way says the step only when the step tells
 * something the activity does not: not when the same one does both, nor when
 * a third of its words are already in the activity. The checker line shows
 * when the card is at its check, and never when the checker is the worker.
 */
export function boardCardLines(f: BoardCardFacts): BoardCardLines {
  const reviewer = !f.reviewerIsWorker && CHECKING.has(f.stage);
  if (f.blockedReason) return { step: false, doing: false, reviewer };
  const step = Boolean(f.step) && !f.stepIsWorkers && !(f.doing && shareOfWords(f.step, f.doing) >= REPEAT_SHARE);
  return { step, doing: Boolean(f.doing), reviewer };
}
