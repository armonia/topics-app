// What a running shell row says while its command prints nothing (CHAT-TOOL-13).
//
// Many commands cannot print while they run: `sleep N`, a pipe into
// tail/head/grep, a python that buffers its output into a pipe. Measured on
// 04/10 over three days of native shells longer than 20 s: 143 of 222 had a
// `sleep`, 93 a pipe into one of those filters; on the CLI runtime no Bash has
// a live source at all. The row showed `$ command` and a spinner, and a 30 s
// `sleep` looked frozen. It now says how long the command has been running and
// that nothing came out yet; for a command that opens with `sleep N`, also how
// much of that wait is left.

const SLEEP_UNIT_MS: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * How long the `sleep` a command OPENS with lasts, in ms; undefined when it
 * opens with anything else. Only the first statement counts: in
 * `sleep 30; echo done` the wait is the command, in `make && sleep 5` it is not
 * where the time goes.
 */
export function leadingSleepMs(command: string | undefined): number | undefined {
  if (!command) return undefined;
  const m = /^\s*sleep\s+(\d+(?:\.\d+)?)([smh]?)(?=\s*(?:$|;|&&|\|\||\n))/.exec(command);
  if (!m) return undefined;
  const ms = Number(m[1]) * SLEEP_UNIT_MS[m[2] ?? '']!;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The time left in whole seconds, rounded up, as a countdown reads: `18s`, `2m 05s`. */
export function formatTimeLeft(ms: number): string {
  const totalS = Math.max(0, Math.ceil(ms / 1000));
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  return `${m}m ${String(totalS % 60).padStart(2, '0')}s`;
}

/** What is left of the opening `sleep` after `elapsedMs`; undefined when there is none, or it is over. */
export function sleepLeftMs(command: string | undefined, elapsedMs: number): number | undefined {
  const total = leadingSleepMs(command);
  if (total === undefined) return undefined;
  const left = total - elapsedMs;
  return left > 0 ? left : undefined;
}
