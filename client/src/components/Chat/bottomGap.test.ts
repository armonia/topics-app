/**
 * A whole pixel short of the bottom is a pixel the reader sees; under a pixel
 * is rounding (`bottomGap.ts`). The geometry is the one traced on the Linux
 * runner in chat-turn-end-still `manytool`: scroll height 1924, viewport 800,
 * and the browser's anchoring left the view at 1123. The wiring is measured end
 * to end by that spec.
 *
 * @covers CHAT-01 USAGE-20
 */
import { describe, expect, test } from 'bun:test';
import { endOfLoadingPinRoute, isParkedAtBottom, isVisibleGap, VISIBLE_GAP_PX } from './bottomGap';

/** Distance from the bottom of the traced scroller at `scrollTop`. */
const traced = (scrollTop: number) => 1924 - scrollTop - 800;

describe('isVisibleGap', () => {
  test('the pixel the anchoring left (1123 of 1124) is a gap the observer closes', () => {
    expect(isVisibleGap(traced(1123))).toBe(true);
  });

  test('at the bottom, or a fraction of a pixel from it, there is nothing to close', () => {
    expect(isVisibleGap(traced(1124))).toBe(false);
    expect(isVisibleGap(traced(1123.5))).toBe(false);
    expect(isVisibleGap(VISIBLE_GAP_PX - 0.01)).toBe(false);
  });

  test('more than a pixel is a gap as well', () => {
    expect(isVisibleGap(traced(1096))).toBe(true);
  });
});

describe('isParkedAtBottom', () => {
  test('at the bottom or a pixel from it the last row is on screen', () => {
    expect(isParkedAtBottom(traced(1124))).toBe(true);
    expect(isParkedAtBottom(traced(1123))).toBe(true);
  });

  test('two pixels or more from it is not parked', () => {
    expect(isParkedAtBottom(traced(1122))).toBe(false);
  });

  test('a list that got shorter under the view leaves it parked: the clamp is not a reader going up', () => {
    // WebKit, `manytool`: the tools folded away, scroll height 1911 -> 1855, scrollTop clamped 1111 -> 1055.
    expect(isParkedAtBottom(1855 - 1055 - 800)).toBe(true);
    // A reader who went up by the same 56 px from that bottom has left it.
    expect(isParkedAtBottom(1911 - 1055 - 800)).toBe(false);
  });
});

describe('endOfLoadingPinRoute', () => {
  test('the sender parked at the bottom is pinned in place, never through Virtuoso', () => {
    expect(endOfLoadingPinRoute(traced(1124))).toEqual({ now: true });
    expect(endOfLoadingPinRoute(traced(1123))).toEqual({ now: true });
  });

  test('away from the bottom the tail may be missing: Virtuoso mounts it, the pin follows two frames later', () => {
    expect(endOfLoadingPinRoute(traced(1122))).toEqual({ viaVirtuoso: true, frames: 2 });
    expect(endOfLoadingPinRoute(traced(0))).toEqual({ viaVirtuoso: true, frames: 2 });
  });

  test('with no scroller to measure, the route that mounts the tail', () => {
    expect(endOfLoadingPinRoute(Infinity)).toEqual({ viaVirtuoso: true, frames: 2 });
  });
});
