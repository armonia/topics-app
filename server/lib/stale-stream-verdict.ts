/**
 * What the StaleStream sweeper should do about a stream that has gone silent.
 *
 * Pure rule, pulled out for the same reason as `pendingAskVerdict` in
 * `ask-user-bridge.ts`: it can be exercised without a stream map, a provider
 * and a CLI child, and the interesting case (a live child on the SECOND stale
 * tick) is otherwise reachable only by waiting six minutes against a real
 * server.
 *
 * The defect this encodes against: the liveness probe used to live INSIDE the
 * one-shot rescue branch, so once the rescue was spent the sweeper finalized
 * without ever asking whether the child was alive. A 12-minute build or a CLI
 * auto-compact (the CLI emits nothing at all while it compacts a full context)
 * therefore ended as "nessuna attività per 3 minuti": the answer was lost and,
 * on a dispatched task, an attempt was burnt.
 *
 * The policy is the one `handleGraceExpiry` and `handleHardTimeout` already
 * apply in `routes/chat.ts`: a turn whose child process is ALIVE is never
 * killed by a clock. The resync stays a one-shot RECOVERY ATTEMPT (issuing it
 * every 30 s against a healthy-but-quiet child is pointless noise); the
 * FINALIZE decision depends only on `childAlive === false`.
 *
 *   - `"ok"`       still inside the silence window: nothing to do.
 *   - `"rescue"`   silent past the window, child alive, no rescue spent yet:
 *                  issue `resyncStream` (the silence may be us having stopped
 *                  HEARING a child that never stopped talking) and bump the
 *                  activity clock.
 *   - `"extend"`   silent past the window but the child is alive and the
 *                  rescue is already spent: bump the clock and keep waiting.
 *                  No new resync, no finalize.
 *   - `"finalize"` the child is gone (or the provider says so): the turn is
 *                  really dead, close it.
 *
 * `childAlive: undefined` means the provider cannot answer — treated as DEAD,
 * unlike `pendingAskVerdict`, because here the pre-existing behaviour of a
 * provider without `isTurnProcessAlive` is to finalize, and a sweeper that
 * never finalizes would leak partial messages forever. The providers that can
 * strand a live child are exactly the ones that implement the probe.
 */
/**
 * THE THIRD STATE, added on 2026-08-28 after paying for its absence.
 *
 * The rule above had TWO states only — alive or dead — and on 28/08 the probe was
 * fixed so that it tells the truth about who owns the session. With that fixed,
 * the defect flipped: `topic:0299ac2d` stayed "streaming" for FIFTEEN MINUTES
 * with zero characters produced and zero tools, extended on every tick by the
 * "a live turn is never killed by a clock" branch. The 30-minute hard cap does
 * not save it either: that one also extends on a live child.
 *
 * The root is that "the process is alive" does NOT mean "the turn is making
 * progress". The native provider holds its AbortController for the whole request,
 * so the probe answers `true` even when the call to the model has stalled and
 * nothing will ever arrive.
 *
 * So three states, not two:
 *  - working (a tool is running) -> no clock touches it, which is the 20/08
 *    protection for the 12-minute build and for auto-compaction;
 *  - silent but alive with nothing in flight -> wait, but NOT forever;
 *  - silent, alive, nothing in flight, past `frozenMs` -> it is stuck, and it is
 *    closed SAYING SO.
 *
 * `frozenMs` is deliberately generous (ten minutes against the "3+ minutes" of
 * silence observed during a compaction): the cost of waiting too long is a few
 * minutes, the cost of cutting a healthy turn is real work thrown away, and that
 * is exactly the mistake this file exists in order not to repeat.
 */
export function staleStreamVerdict(opts: {
  silentMs: number;
  timeoutMs: number;
  childAlive?: boolean;
  alreadyResynced: boolean;
  /** A tool of this turn is executing right now. */
  toolRunning?: boolean;
  /**
   * The TRUE silence, measured from when the silence began and not from the last
   * extension. `silentMs` will not do: every "extend" bumps the activity clock,
   * so that number falls back under the threshold on every tick and NEVER grows.
   * A frozen threshold compared against it would be dead code — the same thing
   * the log line next door already gets right ("the number is the TRUE silence,
   * not the distance from the last extension").
   */
  trueSilenceMs?: number;
  /** How much silence makes a live-but-idle turn count as stuck. */
  frozenMs?: number;
}): "ok" | "rescue" | "extend" | "finalize" | "frozen" {
  if (opts.silentMs <= opts.timeoutMs) return "ok";
  if (opts.childAlive !== true) return "finalize";
  // Really working: no clock touches it, exactly as before.
  if (opts.toolRunning) return opts.alreadyResynced ? "extend" : "rescue";
  const frozenMs = opts.frozenMs ?? 10 * 60 * 1000;
  if ((opts.trueSilenceMs ?? opts.silentMs) >= frozenMs) return "frozen";
  return opts.alreadyResynced ? "extend" : "rescue";
}
