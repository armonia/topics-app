/**
 * Whether a scroll of the chat is the reader's: it follows an input of theirs.
 *
 * A `scroll` event alone does not say who caused it (Virtuoso emits one when it
 * re-measures), but the reader's inputs are observable: wheel, finger, keys, a
 * press on the list. The input PRECEDES the move (at the `keydown` of Home the
 * view is still at the bottom), so each one opens a window. Two moves outlast
 * it and are still the reader's: a press held on the list (its scrollbar
 * dragged, a selection pulled past an edge), and a scroll that goes on once the
 * hand has left (a flick's momentum), whose events come a frame or two apart.
 */
export const GESTURE_WINDOW_MS = 400;
/** Two scroll events this close are one move. */
export const SCROLL_CHAIN_MS = 100;

export interface ReaderGesture {
  /** A wheel, a key that scrolls, a touch. Returns when its window closes. */
  input(now: number): number;
  /** A press on the list: the reader's until it is released. Returns when its window closes. */
  press(now: number): number;
  release(now: number): void;
  /** One scroll event: whether it is the reader's. Every event of the list goes through here. */
  scrolled(now: number): boolean;
}

export function readerGesture(): ReaderGesture {
  let until = 0;
  let held = false;
  let lastScroll = Number.NEGATIVE_INFINITY;
  let lastWasReader = false;
  const input = (now: number): number => (until = now + GESTURE_WINDOW_MS);
  return {
    input,
    press(now) {
      held = true;
      return input(now);
    },
    release(now) {
      if (!held) return;
      held = false;
      until = Math.max(until, now + GESTURE_WINDOW_MS);
    },
    scrolled(now) {
      const reader = now < until || held || (lastWasReader && now - lastScroll <= SCROLL_CHAIN_MS);
      lastScroll = now;
      lastWasReader = reader;
      return reader;
    },
  };
}
