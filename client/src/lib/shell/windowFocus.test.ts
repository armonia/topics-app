/**
 * THE WINDOW FOCUS A PAGE BELIEVES, and the pane polls that obey it.
 *
 * @covers BROWSER-HEAVY-03, BROWSER-HEAVY-05
 */
import { describe, expect, test } from 'bun:test';
import { createWantedEdge, createWindowFocusStore, panePollEnv } from './windowFocus';
import { startVisibilityGatedPoll, type PollEnv } from './visibilityPoll';

describe('window focus store', () => {
  test('unknown until something answers', () => {
    expect(createWindowFocusStore().get()).toBeNull();
  });

  test('an event that lands while the query is in flight wins over its answer', async () => {
    const store = createWindowFocusStore();
    let answer!: (v: boolean) => void;
    const pending = store.query(() => new Promise<boolean>((r) => { answer = r; }));
    store.noteEvent(false);
    answer(true);
    await pending;
    expect(store.get()).toBe(false);
  });

  test('a query answered before any event is applied', async () => {
    const store = createWindowFocusStore();
    await store.query(async () => false);
    expect(store.get()).toBe(false);
  });

  test('a rejected query or a non-boolean answer leaves it unknown', async () => {
    const store = createWindowFocusStore();
    await store.query(async () => { throw new Error('no such command'); });
    await store.query(async () => null);
    expect(store.get()).toBeNull();
  });
});

/** A clock, a document visibility and a subscription, all driven by the test. */
function fakeBase() {
  let visible = true;
  let now = 0;
  const timers = new Map<number, { fn: () => void; ms: number; next: number }>();
  const visibleListeners = new Set<() => void>();
  let handle = 1;
  const base: PollEnv = {
    isVisible: () => visible,
    onVisible(fn) { visibleListeners.add(fn); return () => { visibleListeners.delete(fn); }; },
    setInterval(fn, ms) { const h = handle++; timers.set(h, { fn, ms, next: now + ms }); return h; },
    clearInterval(h) { timers.delete(h); },
  };
  return {
    base,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.fn();
      }
      now = end;
    },
    setVisible(v: boolean) { visible = v; if (v) for (const fn of [...visibleListeners]) fn(); },
  };
}

describe('panePollEnv', () => {
  function bench() {
    const clock = fakeBase();
    const focus = createWindowFocusStore();
    const wanted = createWantedEdge(true);
    const ticks: boolean[] = [];
    const stop = startVisibilityGatedPoll({
      intervalMs: 100,
      tick: (catchUp) => ticks.push(catchUp),
      env: panePollEnv({ wanted: wanted.get, onWanted: wanted.onWanted, focus, base: clock.base }),
    });
    return { clock, focus, wanted, ticks, stop };
  }

  test('zero ticks while any of the three gates is closed', () => {
    const b = bench();
    b.focus.noteEvent(false);
    b.clock.advance(1_000);
    expect(b.ticks).toEqual([]);
    b.focus.noteEvent(true);
    b.ticks.length = 0;
    b.wanted.set(false);
    b.clock.advance(1_000);
    expect(b.ticks).toEqual([]);
    b.stop();
  });

  test('one catch-up tick on each reopening edge', () => {
    const b = bench();
    b.focus.noteEvent(false);
    b.focus.noteEvent(true);
    b.wanted.set(false);
    b.wanted.set(true);
    b.clock.setVisible(false);
    b.clock.setVisible(true);
    expect(b.ticks).toEqual([true, true, true]);
    b.stop();
  });

  test('no catch-up when an edge fires while another gate is still closed', () => {
    const b = bench();
    b.focus.noteEvent(false);
    b.wanted.set(false);
    b.wanted.set(true);
    b.clock.setVisible(false);
    b.clock.setVisible(true);
    expect(b.ticks).toEqual([]);
    b.stop();
  });
});
