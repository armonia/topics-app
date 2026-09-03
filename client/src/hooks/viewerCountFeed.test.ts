/**
 * THE VIEWER COUNT IS PUSHED, NOT POLLED.
 *
 * The defect, measured on the live server log (20,000-line tail): 7,662 of
 * 17,335 API request lines were `GET /api/browsers/:id/viewers`, one every 2s
 * per browser pane, for a value that changes when a device joins or leaves.
 *
 * What this file pins, with the clock in its hands:
 *  - a pushed count is a reading, and it earns exactly ONE confirming fetch
 *    (the fold needs two agreeing samples before the pane moves);
 *  - while a socket of the context is up, the 30s tick fetches nothing;
 *  - while none is, it fetches, at 30s and not at 2s.
 *
 * Nothing here mounts a component: the feed is the piece that decides when a
 * request leaves, and it is driven directly.
 *
 * @covers VIEWCNT-02
 */
import { describe, expect, test } from 'bun:test';
import { CONFIRM_MS, FALLBACK_POLL_MS, startViewerCountFeed } from './viewerCountFeed';

interface Harness {
  fetches: number;
  readings: number[];
  pending: Array<{ ms: number; fire: () => void }>;
  /** Fire the oldest armed timer and return its delay. */
  tick(): number;
  push(count: number): void;
  channel: boolean;
  hidden: boolean;
  run: { stop(): void };
  /** Let the awaited fetch settle. */
  settle(): Promise<void>;
}

function harness(serverCount: () => number | null = () => 0): Harness {
  const pending: Harness['pending'] = [];
  let listener: ((count: number) => void) | null = null;
  const h: Harness = {
    fetches: 0,
    readings: [],
    pending,
    channel: false,
    hidden: false,
    tick: () => {
      const next = pending.shift();
      if (!next) throw new Error('no timer armed');
      next.fire();
      return next.ms;
    },
    push: (count) => { listener?.(count); },
    settle: async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    run: { stop: () => {} },
  };
  h.run = startViewerCountFeed({
    contextId: 'ctx-1',
    fetchCount: async () => { h.fetches += 1; return serverCount(); },
    onReading: (count) => { h.readings.push(count); },
    schedule: (fn, ms) => {
      const entry = { ms, fire: fn };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    subscribe: (_ctx, fn) => { listener = fn; return () => { listener = null; }; },
    hasChannel: () => h.channel,
    isHidden: () => h.hidden,
  });
  return h;
}

describe('a push is a reading, and earns one confirmation', () => {
  test('push -> reading now, one fetch after CONFIRM_MS, nothing else', async () => {
    const h = harness(() => 1);
    await h.settle();
    expect(h.fetches, 'the first reading, before any socket has spoken').toBe(1);
    h.channel = true;

    h.push(1);
    expect(h.readings.at(-1)).toBe(1);
    // The confirmation is the newest timer: the fallback poll was armed at start.
    const confirm = h.pending.at(-1)!;
    expect(confirm.ms).toBe(CONFIRM_MS);
    confirm.fire();
    h.pending.splice(h.pending.indexOf(confirm), 1);
    await h.settle();
    expect(h.fetches).toBe(2);
    expect(h.readings, 'first reading, push, confirmation').toEqual([1, 1, 1]);
    h.run.stop();
  });

  test('a burst of pushes ends with ONE confirmation, after the last push', async () => {
    const h = harness(() => 0);
    await h.settle();
    h.channel = true;
    h.push(1);
    h.push(2);
    h.push(0);
    const confirms = h.pending.filter((t) => t.ms === CONFIRM_MS);
    expect(confirms.length).toBe(1);
    expect(h.readings.slice(1)).toEqual([1, 2, 0]);
    h.run.stop();
  });
});

describe('the fallback poll is a net, not the source', () => {
  test('with a socket up the 30s tick fetches nothing', async () => {
    const h = harness(() => 0);
    await h.settle();
    h.channel = true;
    expect(h.tick()).toBe(FALLBACK_POLL_MS);
    await h.settle();
    expect(h.fetches, 'only the first reading').toBe(1);
    // And it re-arms itself for the next 30s.
    expect(h.pending.some((t) => t.ms === FALLBACK_POLL_MS)).toBe(true);
    h.run.stop();
  });

  test('with no socket it fetches, every 30s and never at 2s', async () => {
    const h = harness(() => 0);
    await h.settle();
    h.channel = false;
    expect(h.tick()).toBe(FALLBACK_POLL_MS);
    await h.settle();
    expect(h.fetches).toBe(2);
    expect(h.tick()).toBe(FALLBACK_POLL_MS);
    await h.settle();
    expect(h.fetches).toBe(3);
    expect(h.pending.every((t) => t.ms >= FALLBACK_POLL_MS)).toBe(true);
    h.run.stop();
  });

  test('a hidden tab takes no reading; a blip is not a reading', async () => {
    const h = harness(() => null);
    await h.settle();
    expect(h.fetches).toBe(1);
    expect(h.readings, 'null from the route is no reading').toEqual([]);
    h.hidden = true;
    h.tick();
    await h.settle();
    expect(h.fetches, 'hidden: the fetch did not leave').toBe(1);
    h.run.stop();
  });

  test('stop disarms every timer and deafens the push', async () => {
    const h = harness(() => 0);
    await h.settle();
    h.push(1);
    h.run.stop();
    expect(h.pending).toEqual([]);
    h.push(2);
    expect(h.readings).toEqual([0, 1]);
  });
});
