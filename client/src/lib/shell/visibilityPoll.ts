/**
 * A periodic poll that stops dead while the document is hidden, and catches up
 * the moment it comes back.
 *
 * WHY IT IS ONE FUNCTION AND NOT FIVE COPIES. `useTauriBrowser` arms five polls
 * per browser pane (page eval at 800 ms, background meta at 2500 ms, the two
 * native drains at 250 ms and 1 s, the focus/context read at 120 ms). Three of
 * them checked visibility and two did not, which cost ~300 wakeups a minute per
 * pane with the app in Cmd+H, minimised or on another Space — and native panes
 * are never evicted (`RESIDENCY_BUDGET.native` is `Infinity` by contract), so
 * the count never came down on its own. A rule that has to be re-typed at every
 * call site is a rule that will be missing at one of them; here it cannot be.
 *
 * THE CATCH-UP IS PART OF THE GATE, not a nicety: without it, returning to the
 * app would wait a whole period (up to 2.5 s) before the address bar, the title
 * and the progress bar realigned. `catchUp` is passed to the tick because the
 * two reads are not equivalent — the queue-draining ticks accumulated a whole
 * hidden period and have to judge what they read (see `pickNavError`), while a
 * periodic tick reads at most one period of history.
 *
 * Every seam is injectable so the behaviour above is testable without a DOM:
 * this project has no jsdom/happy-dom dependency (a declared choice, see
 * `Board/ThreadRuns.test.tsx`).
 */

/** The environment a poll needs. Defaults read the real document/window. */
export interface PollEnv {
  /** Is the document showing? A missing `document` (SSR, unit test) counts as visible. */
  isVisible(): boolean;
  /** Subscribe to "the document became visible again"; returns the unsubscribe. */
  onVisible(fn: () => void): () => void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

/**
 * Visibility, not focus. A click into a native pane makes the CHILD webview key,
 * so the host document's `hasFocus()` reads false exactly when a browser pane is
 * in use; visibility has no such inversion, and an app that is merely not
 * frontmost stays `visible`.
 */
export const documentVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible';

export const DEFAULT_POLL_ENV: PollEnv = {
  isVisible: documentVisible,
  onVisible(fn) {
    if (typeof document === 'undefined') return () => {};
    const handler = (): void => { if (documentVisible()) fn(); };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (handle) => window.clearInterval(handle),
};

export interface VisibilityGatedPollOptions {
  intervalMs: number;
  /** `catchUp` is true only for the read that follows a hidden period. */
  tick: (catchUp: boolean) => void;
  /** Run one tick at once (still gated on visibility) — for polls whose first
   *  answer is what makes a tab show a label at all. */
  prime?: boolean;
  env?: PollEnv;
}

/**
 * Arm the poll. Returns the disposer: it clears the interval AND unsubscribes
 * the catch-up, so an effect cleanup is a single call and cannot half-detach.
 */
export function startVisibilityGatedPoll(opts: VisibilityGatedPollOptions): () => void {
  const env = opts.env ?? DEFAULT_POLL_ENV;
  const run = (catchUp: boolean): void => {
    if (!env.isVisible()) return;
    opts.tick(catchUp);
  };
  if (opts.prime) run(false);
  const handle = env.setInterval(() => run(false), opts.intervalMs);
  const off = env.onVisible(() => run(true));
  return () => {
    off();
    env.clearInterval(handle);
  };
}
