/**
 * A DISCLOSURE A PERSON OPENS IN THE TRANSCRIPT DOES NOT MOVE THE TRANSCRIPT.
 *
 * Every fold in a chat (a run of tool calls, a finished turn's work, a thinking
 * row, a tool's body, the details of an error, a long code block) opens and
 * closes under a click. The clicked row is where the reader's eyes and pointer
 * are, so the one acceptable motion is the body growing or shrinking BELOW it:
 * the row stays at the same height on screen in every frame, and nothing above
 * it moves.
 *
 * Measured before this existed (`tests/e2e/chat-accordion-no-shift.spec.ts`):
 * with the chat at its bottom, opening a fold let the list re-pin to the new
 * bottom and the clicked row climbed by the whole height of its body; closing
 * it let the browser clamp the shorter list and the row dropped by as much.
 * Each fold did it its own way, so there was no one place to fix it.
 *
 * Here is that place. A fold calls `toggled(anchor)` in its click handler,
 * before its state changes, and the transcript (`useDisclosureAnchor`, wired in
 * `MessageList`):
 *  - takes the scroll from the bottom-follow for that toggle, as a wheel does
 *    (`disclosure-toggled` in `scrollAuthority.ts`);
 *  - keeps the anchor at the height it had, frame by frame, until the body has
 *    settled, in the last callback before each paint;
 *  - when closing near the end would make the list shorter than the view,
 *    keeps the missing height as empty room below the last row instead of
 *    letting the browser pull the content down (`--chat-anchor-slack`). That
 *    room is given back as soon as it is out of sight, filled by new output,
 *    or scrolled away by a scroll down past the end.
 *
 * A fold at the END of the transcript (a command's row in the strip, which
 * opens under itself) passes `atEnd`: a reader at the bottom then keeps the
 * bottom instead of the row, so what opens comes into sight above the composer
 * and what closes gives the view back where it was. Anyone further up keeps the
 * row, as with every fold, and no close of such a fold leaves empty room below
 * the strip: where the row cannot be held, the end comes down.
 *
 * `null` outside a transcript (the board's task drawer renders the same rows):
 * a fold there toggles as before.
 */
import { createContext, useCallback, useContext } from 'react';

export interface TranscriptDisclosure {
  /**
   * A person is opening or closing the fold whose header is `anchor`. Called
   * in the click handler, BEFORE the state that opens or closes it changes:
   * the anchor's place is read while the layout is still the old one.
   */
  toggled(anchor: Element, opts?: DisclosureOptions): void;
}

export interface DisclosureOptions {
  /** The fold is the end of the transcript: a reader at the bottom stays at the bottom, and no room is kept below it. */
  atEnd?: boolean;
}

export const TranscriptDisclosureContext = createContext<TranscriptDisclosure | null>(null);

/** The CSS custom property, on the scroller, holding the room kept below the last row. */
export const ANCHOR_SLACK_PROPERTY = '--chat-anchor-slack';

/**
 * The call a fold makes from its click handler. Stable, and a no-op outside a
 * transcript, so every fold can call it unconditionally.
 */
export function useDisclosureToggle(): (anchor: Element | null | undefined, opts?: DisclosureOptions) => void {
  const transcript = useContext(TranscriptDisclosureContext);
  return useCallback((anchor, opts) => {
    if (anchor) transcript?.toggled(anchor, opts);
  }, [transcript]);
}
