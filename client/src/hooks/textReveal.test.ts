/**
 * Gradual reveal of streamed text: lag ceiling, reduced motion, remount.
 * @covers CHAT-REVEAL-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetReducedMotionCache } from '../lib/reducedMotion';
import { MAX_REVEAL_LAG_MS, isRevealOff, nextRevealLength, stepReveal, type RevealState } from './textReveal';

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

describe('stepReveal', () => {
  test('a burst is fully written within the maximum lag, frame by frame', () => {
    let state: RevealState = { shown: 100, last: 0, deadline: 0 };
    const target = 5000;
    let now = 0;
    while (state.shown < target && now < 5000) {
      now += 16;
      state = stepReveal(state, target, now);
    }
    expect(state.shown).toBe(target);
    expect(now).toBeLessThanOrEqual(MAX_REVEAL_LAG_MS);
  });

  test('the deadline is armed on a backlog and cleared once drained', () => {
    let state = stepReveal({ shown: 0, last: 0, deadline: 0 }, 10, 16);
    expect(state.deadline).toBe(16 + 450);
    state = stepReveal(state, 10, 32);
    for (let t = 48; t <= 160; t += 16) state = stepReveal(state, 10, t);
    expect(state.shown).toBe(10);
    expect(stepReveal(state, 10, 176).deadline).toBe(0);
  });

  test('a block remounted mid-turn does not rewrite text that already arrived', () => {
    // The hook starts from the full length of the present text.
    const state = stepReveal({ shown: 300, last: 0, deadline: 0 }, 300, 16);
    expect(state.shown).toBe(300);
    expect(stepReveal(state, 304, 32).shown).toBe(302);
  });
});
