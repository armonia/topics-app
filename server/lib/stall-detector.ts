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
  /** Our OWN pre-review checks are running (or queued) for the task this
   *  session works on. The agent asked for review, the gate answered 202 and
   *  is grinding typecheck/lint/test:unit for minutes: the transcript goes
   *  quiet because it is waiting on US. Read on 2026-09-04, 23:38-00:48: with
   *  four cards delivering under load, every one of them was judged "stuck"
   *  during its own checks and recycled, up to the attempts cap, each recycle
   *  re-posting the delivery. Same contract as the human hold: that time never
   *  counts against the idle clock. */
  isWaitingForChecks?: () => boolean;
  /**
   * A command this session launched is FROZEN by the swap freezer
   * (`services/swap-freeze.ts`): the transcript is silent because Topics itself
   * stopped the process the turn is waiting on. Same contract as the two holds
   * above - our own wait never counts against the idle clock (memory note
   * `our-own-wait-is-not-a-stall`). Bounded by the freeze's own ten minutes.
   */
  isFrozen?: () => boolean;
  /**
   * The session's CLI still reports on background work (an Agent with
   * `run_in_background`, a Bash, a Monitor): the transcript is quiet because
   * the model is waiting for it, and the CLI will speak again when it reports.
   * The judge reads only the transcript, so it cannot see that: on 25/09 it
   * answered alive, alive, then stuck on chat 3019832f with the same tail, and
   * the recycle killed the agent. Bounded by the thirty minutes without news of
   * `claude/background-work.ts`.
   */
  isWaitingForBackground?: () => boolean;
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
  onRearm?: (reason: "human" | "checks" | "freeze" | "background" | "alive") => void;
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
      isWaitingForHuman: () =>
        opts.isWaitingForHuman() || (opts.isWaitingForChecks?.() ?? false) || (opts.isFrozen?.() ?? false)
        || (opts.isWaitingForBackground?.() ?? false),
      now: opts.now,
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      // The inner watch only knows "somebody is holding": name who, for the log.
      onRearm: () => opts.onRearm?.(
        opts.isWaitingForHuman() ? "human" : opts.isFrozen?.() ? "freeze"
          : opts.isWaitingForBackground?.() ? "background" : "checks",
      ),
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
