import { describe, expect, test } from 'bun:test';
import { resolveEdgeSwipe, startsOnScreenEdge } from './edgeSwipe';

/** @covers BROWSER-DOM-NAV-EDGE-01 */
describe('resolveEdgeSwipe', () => {
  test('a left-edge swipe past the threshold goes back and fills its arrow', () => {
    expect(resolveEdgeSwipe(10, 80, 400, 121, 20)).toMatchObject({
      navigation: 'back',
      arrow: { direction: 'back', x: 131, y: 100, ready: true, progress: 1 },
    });
  });

  test('a right-edge swipe past the threshold goes forward', () => {
    expect(resolveEdgeSwipe(390, 80, 400, -121, 20).navigation).toBe('forward');
  });

  test('a horizontal swipe from the center does not navigate', () => {
    expect(resolveEdgeSwipe(200, 80, 400, 150, 10)).toEqual({ navigation: null, arrow: null });
  });

  test('a vertical gesture from the edge remains a scroll', () => {
    expect(resolveEdgeSwipe(10, 80, 400, 20, 60)).toEqual({ navigation: null, arrow: null });
  });

  test('an edge swipe below threshold shows an unfilled arrow without navigating', () => {
    expect(resolveEdgeSwipe(10, 80, 400, 40, 5)).toMatchObject({
      navigation: null,
      arrow: { direction: 'back', x: 50, y: 85, ready: false, progress: 1 / 3 },
    });
  });

  test('edge touch jitter within the tap slop does not start navigation', () => {
    expect(resolveEdgeSwipe(10, 80, 400, 8, 1)).toEqual({ navigation: null, arrow: null });
  });
});

describe('startsOnScreenEdge', () => {
  test('claims the 28 px strips at both screen edges and nothing between', () => {
    expect(startsOnScreenEdge(10, 390)).toBe(true);
    expect(startsOnScreenEdge(380, 390)).toBe(true);
    expect(startsOnScreenEdge(200, 390)).toBe(false);
  });
});

