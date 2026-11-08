/**
 * Does a tool of this turn justify SUSPENDING the soft silence timer?
 *
 * Pure rule, pulled out for the same reason as `staleStreamVerdict` next door:
 * the interesting case is a window of a couple of minutes inside a live stream,
 * and reaching it through a real route means waiting for it.
 *
 * ── The line this file draws ────────────────────────────────────────────────
 * "It is working" and "it is alive" are not the same claim, and the soft timer
 * is allowed to be suspended only by the first one. `routes/chat.ts` suspended
 * it as soon as a tool id entered the tracked set, and that id enters inside
 * `onToolStart`, which fires at `content_block_start`: the moment the model
 * starts WRITING the call, not the moment the call runs. On the native runtime
 * the call is executed only after the whole round has closed, so the route
 * believed it was waiting on a tool while it was merely listening to a stream
 * that could already be dead. Measured on 2026-08-28: two minutes with the
 * fastest guard switched off.
 *
 * ── What must NOT break ─────────────────────────────────────────────────────
 * A tool that really is EXECUTING keeps the timer suspended for as long as it
 * takes - the 12-minute build, the auto-compaction. That protection is the
 * reason the suspension exists at all, and it is worth more than the window
 * this rule recovers.
 *
 * So the answer depends on whether the provider can tell the two moments
 * apart:
 *  - it declares `tool-phases` (it emits `onToolExecStart`): only tools that
 *    have STARTED count. An announced-and-never-executed tool leaves the timer
 *    armed, which is the whole point;
 *  - it does not: the announcement is the only thing it will ever say, so it
 *    keeps meaning "running". Demanding a signal it cannot send would turn
 *    every long CLI tool into a false "the stream is slowing down".
 */
export function toolsSuspendSoftTimer(opts: {
  /** Tools announced by the model (`onToolStart`), executing or not. */
  announced: number;
  /** Tools whose execution has actually begun (`onToolExecStart`). */
  executing: number;
  /** The provider distinguishes the two: it declares the `tool-phases` capability. */
  providerSignalsExecStart: boolean;
}): boolean {
  if (!opts.providerSignalsExecStart) return opts.announced > 0;
  return opts.executing > 0;
}
