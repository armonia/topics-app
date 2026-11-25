/**
 * THE ORDER OF THE COLUMN, BY HAND.
 *
 * The rows of the column (the tabs that are not pinned) keep the order the
 * person gives them by dragging (asked on 24/11: reorder them by hand). A row
 * the order does not know yet, a tab just opened, goes on top, newest first.
 * Nothing moves on its own any more: a row that wants you is lit where it
 * stands, and the "by state" view is where rows gather by what they need.
 */

/** The drag type of a row that can only be placed in the list, not dropped
 *  into the grid: a closed terminal or browser has no pane to place there. */
export const ROW_ORDER_DRAG = 'application/x-topics-row-order';

/** The ids a row of the column can be known by. */
export interface Ordered { id: string }

/**
 * Rows in the hand order: the unknown ones first, in the order they came
 * (activity), then the known ones by their place in `order`.
 */
export function orderByHand<T extends Ordered>(items: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map(order.map((id, i) => [id, i]));
  const fresh: T[] = [];
  const known: T[] = [];
  for (const item of items) (rank.has(item.id) ? known : fresh).push(item);
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...known];
}

/**
 * The order after a drag: `moved` goes before `before` (at the end when it is
 * null), among the rows on screen. Ids the order knew and the screen does not
 * show (another group, a closed search) keep their relative place after them,
 * so a drag inside a filtered list does not lose the rest.
 */
export function moveInOrder(visible: readonly string[], order: readonly string[], moved: string, before: string | null): string[] {
  const shown = visible.filter((id) => id !== moved);
  const at = before === null ? shown.length : shown.indexOf(before);
  shown.splice(at < 0 ? shown.length : at, 0, moved);
  const onScreen = new Set(shown);
  return [...shown, ...order.filter((id) => !onScreen.has(id))];
}
