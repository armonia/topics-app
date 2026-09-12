/**
 * THE ROW THE PREVIEW EXISTS FOR IS THE ONE IT HID.
 *
 * A card's checklist shows at most five steps, the rest behind the fold. The
 * window was `slice(0, 5)`: the first five in order. A checklist is worked
 * top-down, so the first five are the DONE ones, struck through — and the step
 * that is actually open falls past the fold.
 *
 * That is the opposite of what the window is for. `Card.tsx` says as much next
 * to the chip it draws on those rows: a step in progress that nobody is working
 * is exactly what holds the task open. And the card is the only place on the
 * board a subtask is ever seen (the columns carry roots only), so a step nobody
 * is working is visible there or nowhere.
 *
 * MEASURED on 2026-09-12 on a live board, card e1cdd61d: six steps, five done,
 * and the sixth — `8951cc50`, sitting in In Progress since 09/09 with no
 * dispatch state, no agent and zero attempts, carrying `subtaskWork:
 * unattended` from the server — was exactly the `+1` behind the fold. Two days
 * of a card that looked like it was being worked on, with the sentence that
 * said otherwise already computed, already rendered, one click away.
 *
 * So the window is no longer positional: a step that HAS something to say
 * keeps its slot, and a step that has nothing to say gives it up. Order is
 * preserved — the checklist is a sequence, and reordering it to surface a row
 * would trade one misreading for another.
 */

/** How many steps a card shows before the "see all" fold. */
export const CHECKLIST_WINDOW = 5;

export interface ChecklistRow {
  /** Present when the server derived something about who is working this step. */
  subtaskWork?: unknown;
}

/**
 * The steps a card renders, and how many stay folded.
 *
 * Rows carrying `subtaskWork` are picked first, the rest fill what is left, and
 * the result is handed back in the checklist's own order. With five or fewer
 * steps nothing is chosen: every row is shown and `hidden` is 0.
 */
export function checklistWindow<T extends ChecklistRow>(
  rows: readonly T[],
  cap: number = CHECKLIST_WINDOW,
): { shown: T[]; hidden: number } {
  if (rows.length <= cap) return { shown: [...rows], hidden: 0 };

  const picked = new Set<number>();
  for (let i = 0; i < rows.length && picked.size < cap; i++) {
    if (rows[i].subtaskWork) picked.add(i);
  }
  for (let i = 0; i < rows.length && picked.size < cap; i++) {
    picked.add(i);
  }

  const shown = rows.filter((_, i) => picked.has(i));
  return { shown, hidden: rows.length - shown.length };
}
