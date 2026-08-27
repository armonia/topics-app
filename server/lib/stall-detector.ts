/**
 * The passive stall watcher: a judge layered on top of the silence timer,
 * so silence alone never cuts a turn again.
 *
 * `armTurnDeadline` (turn-deadline.ts) already knows how to measure "this
 * session has been quiet for N ms, and rearm while a human is in the loop" —
 * that primitive stays exactly as it was, and is reused here unchanged. What
 * changes is what happens when it expires: instead of calling `onExpired`
 * straight into an abort, this wraps it so EXPIRY ASKS FIRST. The cheap judge
 * (`stall-judge.ts`) reads the transcript tail and answers "alive" or
 * "stuck". "alive" rearms the SAME watch and the turn runs on untouched;
 * only a confirmed "stuck" calls `onStuck()`, once — the caller's job from
 * there is to abort the turn and resume the same session with a system note,
 * which is exactly what recycling means.
 */

import { armTurnDeadline, type TurnDeadline } from "./turn-deadline";
import type { StallVerdict } from "./stall-judge";

export interface StallDetectorOptions {
  /** How long the session must stay silent before the judge is asked. */
  idleMs: number;
  /** A human question or permission prompt is on screen right now? Same
   *  contract as `TurnDeadlineOptions.isWaitingForHuman` — the human's own
   *  time never counts against the idle clock. */
  isWaitingForHuman: () => boolean;
  /** The tail of the transcript to hand the judge. `null` = nothing readable
   *  right now — treated as "alive": never recycle on ignorance. */
  getTail: () => string | null;
  /** The cheap judge call. Never expected to throw (see `judgeStall`), but a
   *  throw here is caught too and read as "alive" — belt and suspenders. */
  judge: (tail: string) => Promise<StallVerdict>;
  /** Fires ONCE, only on a confirmed "stuck" verdict — the recycle trigger. */
  onStuck: () => void;
  /** Fires on every rearm (a human in the loop, or an "alive" verdict) —
   *  logging only, mirrors `TurnDeadlineOptions.onRearm`. */
  onRearm?: (reason: "human" | "alive") => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StallDetector {
  clear(): void;
  /** Forward every sign of life here — same contract as `TurnDeadline.noteActivity`. */
  noteActivity(): void;
}

export function armStallDetector(opts: StallDetectorOptions): StallDetector {
  let stopped = false;
  let inner: TurnDeadline | null = null;

  const startInner = (): void => {
    if (stopped) return;
    inner = armTurnDeadline({
      ms: opts.idleMs,
      isWaitingForHuman: opts.isWaitingForHuman,
      now: opts.now,
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      onRearm: () => opts.onRearm?.("human"),
      onExpired: () => {
        // Fire-and-continue: the inner timer has already stopped ticking (it
        // is single-shot on expiry), so nothing races `startInner` below.
        void (async () => {
          if (stopped) return;
          const tail = opts.getTail();
          const verdict = tail === null
            ? ("alive" as const)
            : await opts.judge(tail).catch(() => "alive" as const);
          if (stopped) return;
          if (verdict === "stuck") {
            stopped = true;
            opts.onStuck();
            return;
          }
          opts.onRearm?.("alive");
          startInner();
        })();
      },
    });
  };
  startInner();

  return {
    clear: () => { stopped = true; inner?.clear(); },
    noteActivity: () => { inner?.noteActivity(); },
  };
}
