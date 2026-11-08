import type { Transform } from '@dnd-kit/utilities';
import { CSS } from '@dnd-kit/utilities';

/**
 * The CSS transform a sortable card draws while another card is dragged, as
 * the string the memoized card body receives.
 *
 * A STRING, because dnd-kit hands a new object on every render and a string
 * compares by value: the body stays put while its transform does not change.
 *
 * NONE for the identity. The vertical list strategy gives every card of the
 * source column `{ x: 0, y: 0, scale 1 }` while the pointer is over that
 * column and `null` when it leaves it, so the string flipped between
 * `translate3d(0px, 0px, 0) scaleX(1) scaleY(1)` and nothing, and every body
 * there re-rendered with no pixel moving (board-drag-renders.spec.ts: 31.7 ->
 * 28.3 renders per pointer move). It also spares those cards a compositing
 * layer each. The card in hand gets none either: the overlay follows the
 * pointer, and the source card stays where it was, dimmed.
 */
export function reflowTransform(transform: Transform | null, isDragging: boolean): string | undefined {
  if (isDragging || !transform) return undefined;
  if (transform.x === 0 && transform.y === 0 && transform.scaleX === 1 && transform.scaleY === 1) return undefined;
  return CSS.Transform.toString(transform);
}
