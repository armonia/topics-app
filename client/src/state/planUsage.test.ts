/**
 * @covers USAGE-21
 *
 * The reading BEFORE the wall: how full the plan's five-hour window is. It
 * follows the same self-expiry rule as the hold next door (USAGE-20), because
 * the server sends no frame for a window merely turning over — and a bar still
 * reading "95%" twenty minutes after the reset is worse than no bar, since it
 * is the number a person decides whether to start something on.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  _adoptForTests,
  _readForTests,
  _resetForTests,
  _subscribeForTests,
} from './planUsage';

/** A `provider:usage` frame as the socket delivers it. */
function usageFrame(fiveHour: { utilization: number; resetsAtMs: number | null } | null, sevenDay: unknown = null): unknown {
  return { type: 'provider:usage', fiveHour, sevenDay, observedAtMs: Date.now() };
}

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

afterEach(() => {
  _resetForTests();
});

describe('USAGE-21: the plan-window reading on the status bar', () => {
  it('adopts the percentage and the reset instant', () => {
    _adoptForTests(usageFrame({ utilization: 82, resetsAtMs: Date.now() + 60_000 }));
    expect(_readForTests()?.fiveHour?.utilization).toBe(82);
  });

  it('ignores every other frame', () => {
    _adoptForTests({ type: 'provider:hold', untilMs: Date.now() + 60_000 });
    expect(_readForTests()).toBeNull();
  });

  it('drops the window when its reset arrives, and says so to its listeners', async () => {
    let announced = 0;
    const off = _subscribeForTests(() => { announced++; });
    _adoptForTests(usageFrame({ utilization: 95, resetsAtMs: Date.now() + 30 }));
    expect(_readForTests()?.fiveHour?.utilization).toBe(95);
    const before = announced;
    await settle(60);
    expect(_readForTests()).toBeNull();
    expect(announced).toBeGreaterThan(before);
    off();
  });

  it('a reading that arrives already past its reset is adopted as nothing', () => {
    _adoptForTests(usageFrame({ utilization: 95, resetsAtMs: Date.now() - 1 }));
    expect(_readForTests()).toBeNull();
  });

  it('the five-hour window can expire while the week is still there', async () => {
    _adoptForTests(usageFrame(
      { utilization: 95, resetsAtMs: Date.now() + 30 },
      { utilization: 40, resetsAtMs: Date.now() + 600_000 },
    ));
    await settle(60);
    expect(_readForTests()?.fiveHour).toBeNull();
    expect(_readForTests()?.sevenDay?.utilization).toBe(40);
  });

  it('a frame with no windows clears the reading', () => {
    _adoptForTests(usageFrame({ utilization: 82, resetsAtMs: Date.now() + 60_000 }));
    _adoptForTests(usageFrame(null));
    expect(_readForTests()).toBeNull();
  });

  it('a window with no reset instant stays until a frame replaces it', async () => {
    _adoptForTests(usageFrame({ utilization: 55, resetsAtMs: null }));
    await settle(20);
    expect(_readForTests()?.fiveHour?.utilization).toBe(55);
  });
});
