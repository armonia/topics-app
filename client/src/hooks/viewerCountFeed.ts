/**
 * Where the readings of the viewer count come from, and how often.
 *
 * THE DEFECT. `useSharedViewerCount` asked `GET /api/browsers/:id/viewers`
 * every 2s per auto-mode pane. On the live log that route was 44% of all API
 * requests (7,662 of 17,335 lines on a 20,000-line tail, ~3 req/s with six
 * panes on two devices) for a value that only moves when a socket joins or
 * leaves. The server now pushes it on the browser socket when it changes
 * (`viewers` frame, see `viewerCountBus`); this module turns those pushes,
 * plus a slow safety net, into the stream of readings the decision folds.
 *
 * THREE SOURCES, ONE STREAM:
 *  - a push from the bus is a reading, right away;
 *  - every push arms ONE confirming fetch after `CONFIRM_MS`. The decision
 *    needs two agreeing samples before the pane moves (`stepAutoShare`), and
 *    a push arrives once: without the confirmation a pane would sit one
 *    sample short of joining a phone that is really there;
 *  - a fetch every `FALLBACK_POLL_MS`, skipped while a socket of the context
 *    is up (the push would have said) or the tab is hidden. Down from 2s: it
 *    is the net under a socket that is down, not the source.
 *
 * Out of the hook so it can fail in a test: the fetch, the clock, the bus and
 * the visibility are injected, the same way `nativeExecutorSocket` does it.
 */
import { hasViewerChannel, subscribeViewerCount } from '../lib/viewerCountBus';

/** One confirming sample after a push: the second of the two the fold wants. */
export const CONFIRM_MS = 2000;
/** The safety-net poll while no socket of the context is up. */
export const FALLBACK_POLL_MS = 30000;

/** Run `fn` after `ms`; returns the cancel. Injectable so a test owns the clock. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export interface ViewerCountFeedOptions {
  contextId: string;
  /** One reading from the route; `null` on a network blip or a non-JSON answer. */
  fetchCount: () => Promise<number | null>;
  /** Every reading, in order. Folding it into a decision is the caller's job. */
  onReading: (count: number) => void;
  schedule?: Schedule;
  subscribe?: (contextId: string, fn: (count: number) => void) => () => void;
  hasChannel?: (contextId: string) => boolean;
  /** Is the tab hidden? A hidden pane takes no reading (it would not agree with anything). */
  isHidden?: () => boolean;
}

export interface ViewerCountFeedRun {
  stop(): void;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

const defaultIsHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function startViewerCountFeed(opts: ViewerCountFeedOptions): ViewerCountFeedRun {
  const schedule = opts.schedule ?? defaultSchedule;
  const subscribe = opts.subscribe ?? subscribeViewerCount;
  const hasChannel = opts.hasChannel ?? hasViewerChannel;
  const isHidden = opts.isHidden ?? defaultIsHidden;

  let stopped = false;
  let cancelPoll: (() => void) | null = null;
  let cancelConfirm: (() => void) | null = null;

  const take = async (): Promise<void> => {
    if (stopped || isHidden()) return;
    let count: number | null = null;
    try { count = await opts.fetchCount(); } catch { count = null; }
    // A reading we did not get is not a reading: feeding the fold a number the
    // server never sent is how a dead link would talk the pane into moving.
    if (stopped || count === null) return;
    opts.onReading(count);
  };

  const armPoll = (): void => {
    if (stopped) return;
    cancelPoll = schedule(() => {
      cancelPoll = null;
      // With a socket up the change has already been pushed: nothing to ask.
      if (!hasChannel(opts.contextId)) void take();
      armPoll();
    }, FALLBACK_POLL_MS);
  };

  const stopListening = subscribe(opts.contextId, (count) => {
    if (stopped) return;
    opts.onReading(count);
    // The confirmation the fold needs, once per push: a burst of pushes ends
    // with one fetch, after the last of them.
    if (cancelConfirm) cancelConfirm();
    cancelConfirm = schedule(() => {
      cancelConfirm = null;
      void take();
    }, CONFIRM_MS);
  });

  // The first reading, before any socket has said anything.
  void take();
  armPoll();

  return {
    stop: () => {
      stopped = true;
      stopListening();
      if (cancelPoll) cancelPoll();
      if (cancelConfirm) cancelConfirm();
      cancelPoll = null;
      cancelConfirm = null;
    },
  };
}
