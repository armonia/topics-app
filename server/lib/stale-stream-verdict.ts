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
export function staleStreamVerdict(opts: {
  silentMs: number;
  timeoutMs: number;
  childAlive?: boolean;
  alreadyResynced: boolean;
}): "ok" | "rescue" | "extend" | "finalize" {
  if (opts.silentMs <= opts.timeoutMs) return "ok";
  if (opts.childAlive !== true) return "finalize";
  return opts.alreadyResynced ? "extend" : "rescue";
}
