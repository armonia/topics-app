import { describe, expect, test } from 'bun:test';
import { flingVelocity } from './mirrorScroll';

/** @covers BROWSER-DOM-SCROLL-01 */

describe('flingVelocity', () => {
  test('the speed of the last 100ms of moves, in px per ms', () => {
    const moves = [
      { t: 0, dx: 0, dy: 50 }, // older than the window
      { t: 900, dx: 0, dy: 10 },
      { t: 916, dx: 0, dy: 16 },
      { t: 932, dx: 4, dy: 16 },
    ];
    const { vx, vy } = flingVelocity(moves, 940);
    expect(vy).toBeCloseTo(32 / 32);
    expect(vx).toBeCloseTo(4 / 32);
  });

  test('a finger that stopped before lifting, or a single move, flings nothing', () => {
    const moves = [{ t: 900, dx: 0, dy: 20 }, { t: 916, dx: 0, dy: 20 }];
    expect(flingVelocity(moves, 990)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([{ t: 900, dx: 0, dy: 20 }], 905)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([], 0)).toEqual({ vx: 0, vy: 0 });
  });
});
