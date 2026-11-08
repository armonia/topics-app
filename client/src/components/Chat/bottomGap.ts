/**
 * A PIXEL SHORT OF THE BOTTOM IS NOT THE BOTTOM.
 *
 * Besides our pins, two hands move a transcript parked at its end, and both
 * work in whole pixels while the rows on screen are fractional (130.48, 59.13,
 * 105.42 px on the Linux runner):
 *
 * - Chromium's own scroll anchoring. Virtuoso turns it off on every row, so the
 *   node the browser anchors to is the Footer under the list. When the last row
 *   grows in a commit after the one our streaming pin ran in (Virtuoso draws a
 *   changed row in a second commit of its own), the browser follows the growth
 *   by the difference of two rounded positions: 27 px for the 27.92 px of an
 *   answer's first line, and the view stopped at 1123 of a bottom at 1124.
 * - Virtuoso's `scrollToIndex('LAST')`, which aims at the bottom of the
 *   whole-pixel sizes it keeps: 1123 again, over the same rows.
 *
 * The first is what the list's ResizeObserver, the pin of the growth nobody
 * announces, read as 1 px and let be: rounding, it assumed. Nothing else moved
 * for the rest of the turn, and the first pin after it, when the turn ended,
 * took the pixel back in the frame the loader went: the whole transcript
 * climbed 1 px (chat-turn-end-still `manytool`, red 3 runs in 3 on Linux
 * Chromium at 4b02e55, 4 in 6 in a run that traced every scroll write). WebKit
 * has no scroll anchoring, so there the observer saw the whole growth and
 * pinned it, and the same test was green.
 *
 * Under a whole pixel the distance is the rounding of a bottom already reached
 * (a fractional scroll offset under a scroll height the browser rounds); a
 * whole pixel is a pixel the reader sees.
 */
export const VISIBLE_GAP_PX = 1;

/** Whether a view `distance` px from the bottom is short of it by a pixel the reader sees. */
export function isVisibleGap(distance: number): boolean {
  return distance >= VISIBLE_GAP_PX;
}

/**
 * Whether a view `distance` px from the bottom is parked there: at the bottom
 * or a pixel from it, so its last row is on screen and a pin in place
 * (`scrollTop = scrollHeight`) reaches the true bottom in the frame it runs.
 *
 * It also says whose a drop of `scrollTop` is. A reader who goes up leaves the
 * bottom; a list that gets shorter under a view parked there (a turn's tools
 * folding away) has the browser clamp `scrollTop` by as much, and the view is
 * still parked. WebKit sent that clamp's `scroll` 195 ms after the pin that had
 * followed it, and the list took it for the reader going up (`onScroll`).
 */
export function isParkedAtBottom(distance: number): boolean {
  return distance <= VISIBLE_GAP_PX;
}

/**
 * How the pin at the end of a loading reaches the bottom.
 *
 * Through Virtuoso when the tail may be missing from the DOM (a history that
 * landed under the list, a reader who sent from the top of the thread):
 * `scrollToIndex('LAST')` mounts it, and the pin two frames later lands on its
 * true height. A history landing is measured before its rows are drawn, when
 * the empty list reads as parked at the bottom, so only the end of a turn that
 * this window carried can go without. Parked at the bottom, as the window that
 * sent the turn watched it, the tail is already on screen, and Virtuoso's
 * whole-pixel aim could only take the view a pixel up for that pin to bring it
 * back: traced at the end of every `manytool` turn, `scrollTo` 1123 of 1124 and
 * the pixel back 5 to 15 ms later, room for a painted frame in between, the
 * frame the loader goes. So only the pin runs, at the same two frames and with
 * the same settling, which still follows the turn's last growth.
 */
export function endOfLoadingPinRoute(at: { carriedTurn: boolean; distance: number }): { frames: 2; viaVirtuoso?: true } {
  return at.carriedTurn && isParkedAtBottom(at.distance) ? { frames: 2 } : { viaVirtuoso: true, frames: 2 };
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
