import { describe, expect, test } from 'bun:test';
import { MERGE_REST_MS, mergeAtRest, type MergeAtRestDeps } from './mergeAtRest';

/**
 * When the rest of a chat's history is merged above the reader: only with the
 * list at rest, the rows here and the pane on screen (`mergeAtRest`).
 *
 * @covers CHAT-HIST-01
 */

/** A list and a clock under the test's hand: a timer runs only when `advance` reaches its time. */
function bench(over: Partial<{ state: string; visible: boolean; inBand: boolean; pressed: boolean }> = {}) {
  let now = 1_000;
  let merges = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const world = { state: 'staged', visible: true, inBand: true, pressed: false, ...over };
  const deps: MergeAtRestDeps = {
    now: () => now,
    later: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    state: () => world.state,
    visible: () => world.visible,
    inBand: () => world.inBand,
    pressed: () => world.pressed,
    merge: () => { merges++; },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { merger: mergeAtRest(deps), world, advance, merges: () => merges };
}

describe('mergeAtRest', () => {
  test('merges once nothing has scrolled for the rest time, and not a millisecond before', () => {
    const b = bench();
    b.merger.scrolled();
    b.merger.want();
    b.advance(MERGE_REST_MS - 1);
    expect(b.merges()).toBe(0);
    b.advance(1);
    expect(b.merges()).toBe(1);
  });

  test('a list still gliding keeps postponing it: every scroll event restarts the wait', () => {
    const b = bench();
    b.merger.scrolled();
    b.merger.want();
    for (let frame = 0; frame < 20; frame++) {
      b.advance(16);
      b.merger.scrolled();
    }
    expect(b.merges()).toBe(0);
    b.advance(MERGE_REST_MS);
    expect(b.merges()).toBe(1);
  });

  test('rows still on their way: it waits for them, and merges when they land on a list at rest', () => {
    const b = bench({ state: 'partial' });
    b.merger.want();
    b.advance(2_000);
    expect(b.merges()).toBe(0);
    b.world.state = 'staged';
    b.merger.poke();
    b.advance(0);
    expect(b.merges()).toBe(1);
  });

  test('a hidden pane does not merge, and keeps the wish for its return whatever its viewport reads', () => {
    const b = bench({ visible: false, inBand: false });
    b.merger.want();
    b.advance(2_000);
    expect(b.merges()).toBe(0);
    b.world.visible = true;
    b.world.inBand = true;
    b.merger.poke();
    b.advance(0);
    expect(b.merges()).toBe(1);
  });

  test('a press held on the list waits for its release', () => {
    const b = bench({ pressed: true });
    b.merger.want();
    b.advance(1_000);
    expect(b.merges()).toBe(0);
    b.world.pressed = false;
    b.advance(MERGE_REST_MS);
    expect(b.merges()).toBe(1);
  });

  test('leaving the band, or a thread made whole some other way, drops the wish', () => {
    for (const away of [{ inBand: false }, { state: 'complete' }]) {
      const b = bench(away);
      b.merger.want();
      b.advance(MERGE_REST_MS);
      Object.assign(b.world, { inBand: true, state: 'staged' });
      b.merger.poke();
      b.advance(MERGE_REST_MS);
      expect(b.merges()).toBe(0);
    }
  });

  test('one merge per wish, and none after dispose', () => {
    const b = bench();
    b.merger.want();
    b.advance(0);
    b.merger.poke();
    b.merger.scrolled();
    b.advance(MERGE_REST_MS);
    expect(b.merges()).toBe(1);
    b.merger.want();
    b.merger.dispose();
    b.advance(MERGE_REST_MS);
    expect(b.merges()).toBe(1);
  });
});
