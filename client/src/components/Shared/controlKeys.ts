/**
 * THE KEYBOARD OF THE MENU'S CONTROLS, as pure functions.
 *
 * `Segmented` and `Stepper` decide what a key does here, so the contract is
 * tested without a DOM (and the component files export components only, which
 * fast refresh needs).
 */

/**
 * Which option an arrow key moves to, or `null` when the key is not ours.
 *
 * Left and right only. Up and down belong to the menu the control sits in
 * (they move between rows), so a segment never swallows them.
 */
export function segmentTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  return null;
}

export interface StepperRange {
  min: number;
  max: number;
  step: number;
}

/** How many steps Page Up and Page Down move. */
const PAGE_STEPS = 4;

/**
 * The value a key moves to, clamped to the range, or `null` when the key is
 * not ours. Pure, so the keyboard contract is tested without a DOM.
 *
 * Right and left move one step, as they move a segment. Up and down belong to
 * the menu the stepper sits in (they move between rows): taken here, an arrow
 * down meant to reach the next row lowered the value instead.
 */
export function stepperValue(key: string, value: number, { min, max, step }: StepperRange): number | null {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  switch (key) {
    case 'ArrowRight': return clamp(value + step);
    case 'ArrowLeft': return clamp(value - step);
    case 'PageUp': return clamp(value + step * PAGE_STEPS);
    case 'PageDown': return clamp(value - step * PAGE_STEPS);
    case 'Home': return min;
    case 'End': return max;
    default: return null;
  }
}

