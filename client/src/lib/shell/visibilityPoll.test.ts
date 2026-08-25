/**
 * A HIDDEN WINDOW COSTS NOTHING, AND COMING BACK COSTS EXACTLY ONE READ.
 *
 * The defect this replaces was in the TEST, not only in the code: the guard for
 * "every poll stops while hidden" was a set of `readFileSync(...).includes(...)`
 * assertions over `useTauriBrowser.ts`. It never ran a poll, so it could not
 * tell a gate that works from a gate that is merely written down, and its
 * catch-up count matched the `onDocumentVisible` DEFINITION as well as the call
 * sites (6 against an assertion of `>= 5`, so deleting a real call site still
 * passed).
 *
 * The scheduler is now one function with injectable seams, and these tests run
 * it: a fake clock, a fake visibility state, a fake subscription. What is left
 * for the source-level guard is only "every poll in the hook goes through this
 * function", which is a claim about wiring and is checked as one.
 *
 * @covers LEAK-01
 */
import { describe, expect, test } from 'bun:test';
import { startVisibilityGatedPoll, type PollEnv } from './visibilityPoll';

interface Fake {
  env: PollEnv;
  ticks: boolean[];
  /** Advance the clock by `ms`, firing every interval that is due. */
  advance(ms: number): void;
  show(): void;
  hide(): void;
  /** Fire the subscription WITHOUT becoming visible (a hide is a
   *  visibilitychange too, and the real listener sees both). */
  fireVisibilityEvent(): void;
  /** Timers still armed + visibility listeners still subscribed. */
  live(): { timers: number; listeners: number };
}

function fake(startVisible: boolean, ticks: boolean[]): Fake {
  let visible = startVisible;
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { fn: () => void; ms: number; next: number }>();
  const listeners = new Set<() => void>();
  const env: PollEnv = {
    isVisible: () => visible,
    onVisible(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setInterval(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { fn, ms, next: now + ms });
      return handle;
    },
    clearInterval(handle) { timers.delete(handle); },
  };
  return {
    env,
    ticks,
    advance(ms) {
      const target = now + ms;
      // Fire in time order so a poll cannot run twice for one period.
      for (;;) {
        let due: { handle: number; at: number } | null = null;
        for (const [handle, t] of timers) {
          if (t.next <= target && (!due || t.next < due.at)) due = { handle, at: t.next };
        }
        if (!due) break;
        const t = timers.get(due.handle)!;
        now = t.next;
        t.next += t.ms;
        t.fn();
      }
      now = target;
    },
    show() { visible = true; for (const fn of [...listeners]) fn(); },
    hide() { visible = false; },
    fireVisibilityEvent() { for (const fn of [...listeners]) fn(); },
    live: () => ({ timers: timers.size, listeners: listeners.size }),
  };
}

describe('startVisibilityGatedPoll', () => {
  test('a visible document ticks once per period, never with catchUp', () => {
    const ticks: boolean[] = [];
    const f = fake(true, ticks);
    startVisibilityGatedPoll({ intervalMs: 250, tick: (c) => ticks.push(c), env: f.env });
    f.advance(1000);
    expect(ticks).toEqual([false, false, false, false]);
  });

  test('THE DEFECT: a hidden document spends ZERO wakeups, however long it stays hidden', () => {
    const ticks: boolean[] = [];
    const f = fake(false, ticks);
    startVisibilityGatedPoll({ intervalMs: 120, tick: (c) => ticks.push(c), prime: true, env: f.env });
    f.advance(60_000); // one minute in Cmd+H: 500 wakeups before the gate
    expect(ticks).toEqual([]);
  });

  test('coming back is ONE catch-up read, marked as such', () => {
    const ticks: boolean[] = [];
    const f = fake(false, ticks);
    startVisibilityGatedPoll({ intervalMs: 1000, tick: (c) => ticks.push(c), env: f.env });
    f.advance(10_000);
    f.show();
    expect(ticks).toEqual([true]);
    // …and the periodic beat resumes from there, as a normal read.
    f.advance(1000);
    expect(ticks).toEqual([true, false]);
  });

  test('a visibilitychange while still hidden fires nothing (the event is not the state)', () => {
    const ticks: boolean[] = [];
    const f = fake(true, ticks);
    startVisibilityGatedPoll({ intervalMs: 1000, tick: (c) => ticks.push(c), env: f.env });
    f.hide();
    // Going hidden is a visibilitychange too. Only `isVisible` decides.
    f.fireVisibilityEvent();
    f.advance(5000);
    expect(ticks).toEqual([]);
  });

  test('prime runs immediately when visible, and is gated when not', () => {
    const shown: boolean[] = [];
    const fVisible = fake(true, shown);
    startVisibilityGatedPoll({ intervalMs: 10_000, tick: (c) => shown.push(c), prime: true, env: fVisible.env });
    expect(shown).toEqual([false]);

    const hiddenTicks: boolean[] = [];
    const fHidden = fake(false, hiddenTicks);
    startVisibilityGatedPoll({ intervalMs: 10_000, tick: (c) => hiddenTicks.push(c), prime: true, env: fHidden.env });
    expect(hiddenTicks).toEqual([]);
  });

  test('the disposer detaches BOTH halves: no timer, no listener, no late tick', () => {
    const ticks: boolean[] = [];
    const f = fake(true, ticks);
    const stop = startVisibilityGatedPoll({ intervalMs: 100, tick: (c) => ticks.push(c), env: f.env });
    f.advance(100);
    expect(ticks.length).toBe(1);
    stop();
    expect(f.live()).toEqual({ timers: 0, listeners: 0 });
    f.advance(1000);
    f.show();
    expect(ticks.length).toBe(1);
  });
});
