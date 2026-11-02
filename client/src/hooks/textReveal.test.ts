import { afterEach, describe, expect, test } from 'bun:test';
import { resetReducedMotionCache } from '../lib/reducedMotion';
import { MAX_REVEAL_LAG_MS, isRevealOff, nextRevealLength } from './textReveal';

function drainTime(burst: number, frameMs: number): number {
  let shown = 0;
  let t = 0;
  while (shown < burst) {
    shown = nextRevealLength(shown, burst, frameMs, 450 - t);
    t += frameMs;
    if (t > 10_000) break;
  }
  return t;
}

describe('nextRevealLength', () => {
  test('writes 2-3 characters per frame on a small backlog', () => {
    expect(nextRevealLength(0, 10, 16, 450)).toBe(2);
    expect(nextRevealLength(0, 1, 16, 450)).toBe(1);
  });

  test('never overshoots the arrived text', () => {
    expect(nextRevealLength(5, 5, 16, 450)).toBe(5);
    expect(nextRevealLength(9, 10, 16, 450)).toBe(10);
  });

  test.each([20, 200, 2000, 20000])('drains a burst of %i chars within the maximum lag', (burst) => {
    for (const frameMs of [8, 16, 33, 50]) {
      expect(drainTime(burst, frameMs)).toBeLessThanOrEqual(MAX_REVEAL_LAG_MS);
    }
  });
});

describe('isRevealOff', () => {
  const g = globalThis as unknown as { window: unknown };
  const realWindow = g.window;
  afterEach(() => {
    if (realWindow === undefined) delete g.window;
    else g.window = realWindow;
    resetReducedMotionCache();
  });

  test('history (not enabled) is never revealed', () => {
    expect(isRevealOff(false)).toBe(true);
  });

  test('prefers-reduced-motion turns the reveal off', () => {
    g.window = { matchMedia: () => ({ matches: true }) };
    expect(isRevealOff(true)).toBe(true);
  });

  test('live text with no reduced-motion preference is revealed', () => {
    g.window = { matchMedia: () => ({ matches: false }) };
    expect(isRevealOff(true)).toBe(false);
  });
});
