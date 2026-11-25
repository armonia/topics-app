/**
 * The split from the keyboard: a divider moves with the arrows (SPLIT-04), the
 * focus walks to the cell beside with ⌘⌥ + arrows (SPLIT-06).
 *
 * The divider follows the WAI-ARIA window splitter: the arrows along its axis
 * move it, Shift makes the step fine, Enter evens the band out (what a
 * double-click does). The neighbor is chosen by geometry, not by the order
 * of the model: the cell whose centre lies in that direction, nearest first,
 * with a penalty for drifting off the line, so «right» from a short cell in a
 * stacked column lands on the cell you see on its right.
 */

export const KEY_STEP = 0.05;
export const KEY_STEP_FINE = 0.01;

export type DividerKeyAction = { kind: 'resize'; fraction: number } | { kind: 'equalize' } | null;

/** What a key does on a divider. `horizontal` = the divider moves along X
 *  (children side by side). */
export function dividerKeyAction(key: string, shift: boolean, horizontal: boolean): DividerKeyAction {
  if (key === 'Enter') return { kind: 'equalize' };
  const step = shift ? KEY_STEP_FINE : KEY_STEP;
  const [less, more] = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  if (key === less) return { kind: 'resize', fraction: -step };
  if (key === more) return { kind: 'resize', fraction: step };
  return null;
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

export interface CellBox { id: string; left: number; top: number; width: number; height: number }

export function arrowDirection(key: string): FocusDirection | null {
  switch (key) {
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    default: return null;
  }
}

/** The cell beside `fromId` in `dir`, or null at the edge of the layout. */
export function neighborCell(cells: readonly CellBox[], fromId: string, dir: FocusDirection): string | null {
  const from = cells.find((c) => c.id === fromId);
  if (!from) return null;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  let best: { id: string; score: number } | null = null;
  for (const c of cells) {
    if (c.id === fromId) continue;
    const dx = c.left + c.width / 2 - cx;
    const dy = c.top + c.height / 2 - cy;
    const along = (horizontal ? dx : dy) * sign;
    if (along <= 1) continue;
    const across = Math.abs(horizontal ? dy : dx);
    const score = along + 2 * across;
    if (!best || score < best.score) best = { id: c.id, score };
  }
  return best?.id ?? null;
}

/** The cells on screen, by the pane each one focuses (`data-focus-pane`). */
export function cellBoxesOnScreen(root: ParentNode = document): CellBox[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-focus-pane]')).flatMap((el) => {
    const r = el.getBoundingClientRect();
    const id = el.dataset.focusPane;
    return id && r.width > 0 && r.height > 0 ? [{ id, left: r.left, top: r.top, width: r.width, height: r.height }] : [];
  });
}
