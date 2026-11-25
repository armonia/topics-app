/**
 * Where the detail slider's knob lands for a press and for a drag. Pure, so the
 * two behaviours are tested without a pointer (densityStops.test.ts).
 */

/** A press: on the track the nearest stop; on an end glyph (outside the track) one step that way. */
export function densityStopForPress(ratio: number, at: number, last: number): number {
  const i = ratio < 0 ? at - 1 : ratio > 1 ? at + 1 : Math.round(ratio * last);
  return Math.max(0, Math.min(last, i));
}

/** A drag: the nearest stop, resting on the end once the pointer is past it (never stepping again). */
export function densityStopForDrag(ratio: number, last: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * last);
}
