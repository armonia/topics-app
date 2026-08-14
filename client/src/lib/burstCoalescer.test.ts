import { describe, expect, test } from 'bun:test';
import { createBurstCoalescer, latestWins } from './burstCoalescer';

/** A hand-driven clock: the test decides when a window expires. */
function fakeClock() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => { timers.set(++seq, fn); return seq; },
    cancel: (h: unknown) => { timers.delete(h as number); },
    /** Expires every timer armed right now (not the ones armed during the firing). */
    tick: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, fn] of due) fn();
    },
    get armed() { return timers.size; },
  };
}

function counter() {
  const state = { runs: 0 };
  return { state, run: async () => { state.runs++; } };
}

describe('createBurstCoalescer', () => {
  test('the first event fires RIGHT AWAY: whoever just moved a card does not wait', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    expect(state.runs).toBe(1);
  });

  test('24 events in the same window cost TWO reads, not 24', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    for (let i = 0; i < 24; i++) c.trigger();
    expect(state.runs).toBe(1); // only the first one, the other 23 are queued
    clock.tick();
    expect(state.runs).toBe(2); // the tail: a single state, the final one
    clock.tick();
    expect(state.runs).toBe(2); // and no empty read after that
  });

  test('no event during the window: no read in the tail', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    clock.tick();
    expect(state.runs).toBe(1);
  });

  test('the final read is always AFTER the last event', () => {
    const clock = fakeClock();
    const events: string[] = [];
    const c = createBurstCoalescer({
      windowMs: 400,
      run: async () => { events.push('read'); },
      schedule: clock.schedule, cancel: clock.cancel,
    });
    c.trigger(); events.push('event1');
    c.trigger(); events.push('event2');
    clock.tick();
    expect(events).toEqual(['read', 'event1', 'event2', 'read']);
  });

  test('window closed: a new event fires again right away', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    clock.tick();          // window closed with no tail
    c.trigger();
    expect(state.runs).toBe(2);
  });

  test('dispose shuts down the tail and every later event', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    c.trigger();           // queues one
    c.dispose();
    expect(clock.armed).toBe(0);
    clock.tick();
    c.trigger();
    expect(state.runs).toBe(1);
  });

  test('an error in a read does not block the later ones', async () => {
    const clock = fakeClock();
    let runs = 0;
    const c = createBurstCoalescer({
      windowMs: 400,
      run: async () => { runs++; throw new Error('network down'); },
      schedule: clock.schedule, cancel: clock.cancel,
    });
    c.trigger();
    c.trigger();
    await Promise.resolve();
    clock.tick();
    expect(runs).toBe(2);
  });
});

describe('latestWins', () => {
  test('a SUPERSEDED response does not write over a more recent one', async () => {
    const written: string[] = [];
    const guarded = latestWins<string>((v) => written.push(v));
    let unblockSlow: (v: string) => void = () => {};
    const slow = new Promise<string>((res) => { unblockSlow = res; });

    const p1 = guarded(() => slow);                   // starts first, comes back last
    const p2 = guarded(() => Promise.resolve('new'));
    await p2;
    unblockSlow('old');
    await p1;

    expect(written).toEqual(['new']);
  });

  test('in sequence they all write', async () => {
    const written: string[] = [];
    const guarded = latestWins<string>((v) => written.push(v));
    await guarded(() => Promise.resolve('a'));
    await guarded(() => Promise.resolve('b'));
    expect(written).toEqual(['a', 'b']);
  });
});
