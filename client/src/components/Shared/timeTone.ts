/**
 * WHICH TIME IS THIS, said with colour instead of with words.
 *
 * Two durations live next to each other on rows and tabs, and they answer
 * opposite questions:
 *   · "it has been going for 12m"  — running now, the number grows while you
 *     look at it. It belongs to the same event the loader is drawing.
 *   · "it answered 12m ago"        — finished, the number is a receipt and it
 *     will only get older.
 * Both were the same grey, so the only way to tell them apart was to read the
 * sentence around them, and on a tab there is no sentence.
 *
 * The rule here is one line long: the live number wears the loader's colour and
 * the loader's motion (`time-live` in index.css, primary + the shared shimmer),
 * a number parked on a question wears the amber of the frozen ring, and a
 * receipt keeps the quiet tone the surface already gives it.
 *
 * `onFill` is the exception that keeps it legible: on an attention fill (amber
 * or blue) the row already paints its text white, and a primary gradient on top
 * of that would be a second colour fighting the first. There the caller's
 * on-fill tone wins and this returns nothing.
 */

/** What the number is measuring, from the surface's point of view. */
export type TimeVoice = 'live' | 'waiting' | 'past';

/**
 * The extra classes for a time readout, or `null` when the surface should keep
 * its own quiet tone (a receipt, or any number sitting on an attention fill).
 */
export function timeToneClass(voice: TimeVoice, onFill = false): string | null {
  if (onFill) return null;
  if (voice === 'live') return 'time-live';
  if (voice === 'waiting') return 'text-amber-600 dark:text-amber-400';
  return null;
}

/** The voice of a subject's time, from the two facts every surface already has:
 *  is it working, and is it parked waiting for the user. */
export function timeVoice(working: boolean, awaitingInput: boolean): TimeVoice {
  if (working) return 'live';
  return awaitingInput ? 'waiting' : 'past';
}
