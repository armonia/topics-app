/**
 * ONE CLOCK FOR THE RELATIVE AGES ("ora", "3m fa", "2h fa").
 *
 * A label that says how old something is goes stale on its own: nothing about
 * the row changes, only the time. A card used to get those redraws by accident
 * (every `task:updated` frame re-rendered every card); since it renders only
 * when its own props change, a quiet card said "ora" for good. One interval
 * per label would be a timer per card on a board of hundreds.
 *
 * So one timer per document: it fires on the wall-clock minute, starts with
 * the first listener and stops with the last one, sleeps while the window is
 * hidden and fires at once when it comes back. The snapshot is a tick count,
 * not the time: subscribing never changes it, so a board that mounts sixty
 * labels does not render them twice. A label reads the real time when it
 * renders; the tick only tells it to render.
 */

const MINUTE_MS = 60_000;

type VisibilityTarget = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** What the clock needs from the page; the unit tests hand it a fake one. */
export interface MinuteClockEnv {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** `null` outside a browser: the clock then never sleeps. */
  doc: VisibilityTarget | null;
}

export interface MinuteClock {
  subscribe: (listener: () => void) => () => void;
  /** Ticks fired so far: a new value means "the minute changed, render again". */
  getSnapshot: () => number;
}

export function createMinuteClock(env: MinuteClockEnv): MinuteClock {
  const listeners = new Set<() => void>();
  let ticks = 0;
  let timer: unknown = null;

  const hidden = () => env.doc?.visibilityState === 'hidden';

  const disarm = () => {
    if (timer === null) return;
    env.clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    disarm();
    if (listeners.size === 0 || hidden()) return;
    timer = env.setTimeout(tick, MINUTE_MS - (env.now() % MINUTE_MS));
  };

  function tick() {
    timer = null;
    ticks += 1;
    for (const listener of [...listeners]) listener();
    arm();
  }

  // Back to visible: the minutes spent hidden show at once, then the timer
  // goes back on the minute. Hidden: no timer, nobody renders in the dark.
  const onVisibility = () => {
    if (hidden()) disarm();
    else tick();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        env.doc?.addEventListener('visibilitychange', onVisibility);
        arm();
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        disarm();
        env.doc?.removeEventListener('visibilitychange', onVisibility);
      };
    },
    getSnapshot: () => ticks,
  };
}

const clock = createMinuteClock({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  doc: typeof document === 'undefined' ? null : document,
});

/** The document's clock, in the shape `useSyncExternalStore` wants. */
export const subscribeMinuteClock = clock.subscribe;
export const getMinuteClockSnapshot = clock.getSnapshot;
