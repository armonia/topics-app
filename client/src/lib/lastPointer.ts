/**
 * Which kind of pointer touched the page last: mouse, pen or finger.
 *
 * A tap on a phone is followed by COMPATIBILITY mouse events (`mouseover`,
 * `mouseenter`, `mousemove`) aimed at whatever sits under the finger, so a
 * hover-driven surface cannot tell a finger from a cursor by the mouse events
 * alone. On iOS that hover state also sticks after the finger lifts: a tooltip
 * opened by it stays on screen over the next view. Pointer events carry the
 * answer (`pointerType`), and every compatibility `mouseover` is preceded by the
 * `pointerover`/`pointerdown` of the same gesture, so remembering the last one
 * is enough to know where a `mouseover` came from.
 *
 * One capture listener for the whole app, installed on first use.
 */

let last: string | null = null;
let installed = false;

function remember(e: PointerEvent): void {
  last = e.pointerType || null;
}

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerover', remember, true);
  document.addEventListener('pointerdown', remember, true);
}

/**
 * True when the last pointer that reached the page was a finger. `null` (no
 * pointer event yet, or a synthetic `mouseover` dispatched by a script) counts
 * as not-touch: a cursor is the safe assumption for showing a hint.
 */
export function lastPointerWasTouch(): boolean {
  install();
  return last === 'touch';
}

/** Arms the listener before the first hover arrives (call at mount). */
export function watchPointerType(): void {
  install();
}

/** Test seam: forget the last pointer. */
export function _resetLastPointerForTests(): void {
  last = null;
}
