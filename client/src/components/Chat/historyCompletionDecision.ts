/**
 * "Can the rest of the history be merged into this list NOW?" - the one
 * decision of a tail-first open (`shared/history-paging.ts`) that depends on
 * who is looking, kept pure so it tests under bun:test.
 *
 * WHY "HIDDEN" IS THE ONLY YES. The list is virtual (Virtuoso): its rows are
 * addressed by index, so prepending eighty messages makes "item 30" a different
 * message. While the pane is on screen that shows, whatever the viewport was
 * doing:
 *
 *  - anchored at the bottom, untouched: the frame after the merge renders the
 *    SAME indices with older content (Virtuoso learns the new scroll position
 *    from the scroll event, one frame later), then `followOutput` glides back to
 *    the bottom. One frame of the wrong rows, then a visible move.
 *  - the official remedy, `firstItemIndex`, was measured on this very list at
 *    CLS 0.60 (a margin on the list, a `scrollBy` the frame after, the margin
 *    lifted the frame after that: three frames of movement, branch
 *    `experiment/chat-tail-first-virtuoso-prepend`). PERF-01 caps a return at
 *    0.01.
 *
 * So "anchored at the bottom" is not a yes: it decides only HOW the viewport is
 * put back once the merge has happened out of sight. A pane behind another tab
 * (`display:none`, viewport 0 px high) renders no rows, and Virtuoso rebuilds
 * the list from scratch when it comes back: that is the moment nothing can be
 * seen moving, and the existing "pane returns visible" pin already lands it.
 * `document.hidden` is deliberately NOT enough: a hidden window still keeps a
 * laid-out viewport, and the first frame after it returns would be the frame
 * described above.
 *
 * A streaming turn waits too: the live tail is measured every frame and the
 * merge would land in the middle of that, for a gain nobody sees while the
 * pane is hidden anyway.
 *
 * The reader who has scrolled up gets the "load the earlier messages" row at
 * the top of the loaded window instead (`LoadEarlierDivider`): a jump they
 * asked for is not a shift.
 */

export interface HistoryCompletionSituation {
  /** The pane has no box in the layout: a tab behind another, viewport 0 px. */
  paneHidden: boolean;
  /** A turn is streaming into this list. */
  streaming: boolean;
  /** The person has scrolled this list since it opened (a real gesture). */
  userScrolled: boolean;
  /** The viewport sits at the bottom of the loaded window. */
  anchoredAtBottom: boolean;
}

export type HistoryCompletionDecision =
  | { action: 'wait' }
  | {
      action: 'complete';
      /**
       * Where to put the viewport when the pane is looked at again: back at
       * the bottom when that is where it was resting, or on the row that was
       * at the top of the viewport when the reader had scrolled - its index
       * changes by the number of rows added above it.
       */
      restore: 'bottom' | 'top-item';
    };

export function decideHistoryCompletion(s: HistoryCompletionSituation): HistoryCompletionDecision {
  if (!s.paneHidden) return { action: 'wait' };
  if (s.streaming) return { action: 'wait' };
  const resting = !s.userScrolled && s.anchoredAtBottom;
  return { action: 'complete', restore: resting ? 'bottom' : 'top-item' };
}
