/**
 * THE MINUTE CLOCK: one timer, on the minute, only while someone listens.
 *
 * The board's age labels ("3m fa") read it (`Board/UpdatedAgo.tsx`); the e2e
 * `board-card-updated-ago.spec.ts` proves the label moves. Here, the timer's
 * own rules, on a fake page: when it fires, that it stops with the last
 * listener (a clock left running is a leak in a long session), that it sleeps
 * while the window is hidden and fires at once when it comes back.
 *
 * @covers KANBAN-01
 */
import { describe, expect, test } from 'bun:test';
import { createMinuteClock, type MinuteClockEnv } from './minuteClock';

/** A page with a hand-driven clock and visibility. */
function fakePage(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const visibility = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') visibility.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') visibility.delete(fn); },
  };
  const env: MinuteClockEnv = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    doc: doc as unknown as MinuteClockEnv['doc'],
  };
  return {
    env,
    timers,
    visibility,
    /** Moves the time forward, firing every timer that falls due, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const fn of [...visibility]) fn();
    },
  };
}

const T0 = Date.UTC(2026, 9, 8, 12, 0, 20); // 20 s past a minute

describe('the minute clock', () => {
  test('no listener, no timer; the first one arms it on the next minute', () => {
    const page = fakePage(T0);
    const clock = createMinuteClock(page.env);
    expect(page.timers.size).toBe(0);
    let calls = 0;
    clock.subscribe(() => { calls += 1; });
    expect(page.timers.size).toBe(1);
    expect(clock.getSnapshot()).toBe(0);

    page.advance(39_999);
    expect(calls).toBe(0);
    page.advance(1);
    expect(calls).toBe(1);
    expect(clock.getSnapshot()).toBe(1);

    page.advance(3 * 60_000);
    expect(calls).toBe(4);
    expect(page.timers.size).toBe(1);
  });

  test('one timer for any number of listeners, gone with the last one', () => {
    const page = fakePage(T0);
    const clock = createMinuteClock(page.env);
    const seen = [0, 0, 0];
    const offs = seen.map((_, i) => clock.subscribe(() => { seen[i] += 1; }));
    expect(page.timers.size).toBe(1);
    expect(page.visibility.size).toBe(1);

    page.advance(40_000);
    expect(seen).toEqual([1, 1, 1]);

    offs[0]();
    offs[0]();
    offs[1]();
    expect(page.timers.size).toBe(1);
    offs[2]();
    expect(page.timers.size).toBe(0);
    expect(page.visibility.size).toBe(0);
    page.advance(10 * 60_000);
    expect(seen).toEqual([1, 1, 1]);
  });

  test('subscribing does not change the snapshot: a board mounting its labels renders them once', () => {
    const page = fakePage(T0);
    const clock = createMinuteClock(page.env);
    const before = clock.getSnapshot();
    clock.subscribe(() => {});
    clock.subscribe(() => {});
    expect(clock.getSnapshot()).toBe(before);
  });

  test('hidden it sleeps; visible again it fires at once and goes back on the minute', () => {
    const page = fakePage(T0);
    const clock = createMinuteClock(page.env);
    let calls = 0;
    clock.subscribe(() => { calls += 1; });

    page.setVisibility('hidden');
    expect(page.timers.size).toBe(0);
    page.advance(5 * 60_000);
    expect(calls).toBe(0);

    page.setVisibility('visible');
    expect(calls).toBe(1);
    expect(page.timers.size).toBe(1);
    // T0 + 5 min is 20 s past a minute: the next tick is 40 s away.
    page.advance(39_999);
    expect(calls).toBe(1);
    page.advance(1);
    expect(calls).toBe(2);
  });

  test('a listener that leaves inside a tick does not keep the timer alive', () => {
    const page = fakePage(T0);
    const clock = createMinuteClock(page.env);
    const off = clock.subscribe(() => off());
    page.advance(40_000);
    expect(page.timers.size).toBe(0);
  });
});
