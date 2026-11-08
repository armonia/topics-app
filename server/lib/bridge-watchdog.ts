import { shouldRecycleSocket } from "./ai-bridge-client";

/** What the terminal bridge watchdog should do on this tick. */
export type WatchdogAction = "ok" | "soft-reset" | "sigterm";

export const BRIDGE_MUTE_MS = 60_000;
export const BRIDGE_ESCALATE_MS = 30_000;

/**
 * The watchdog's verdict, as a function instead of three branches inside a
 * `setInterval`.
 *
 * It is the only place that decides whether every PTY on the machine dies, and
 * a decision that expensive cannot be one nobody can run: reaching the SIGTERM
 * branch through the real timers takes 95 seconds and a hung daemon.
 *
 * TWO STAGES, because the two failure modes it has to cover need opposite
 * cures. A one-way socket break is fixed by dropping the socket, which costs
 * nothing (the `close` handler reconnects and reconciles). A hung daemon is
 * fixed only by SIGTERM, which kills every PTY it owns. Doing the expensive one
 * first, which is what the code did until 2026-08-21, paid the second cost for
 * the first problem 31 times.
 *
 * @param armedAt when the soft stage last fired, 0 when disarmed. A real pong
 *   disarms it; a reconnect deliberately does not, or a daemon that accepts
 *   connections and answers nothing would loop through soft resets forever.
 */
export function bridgeWatchdogStep(
  now: number,
  lastPongAt: number,
  lastByteAt: number,
  armedAt: number,
  muteMs: number = BRIDGE_MUTE_MS,
  escalateMs: number = BRIDGE_ESCALATE_MS,
): WatchdogAction {
  if (!shouldRecycleSocket(now, lastPongAt, lastByteAt, muteMs)) return "ok";
  if (!armedAt) return "soft-reset";
  return now - armedAt >= escalateMs ? "sigterm" : "ok";
}
