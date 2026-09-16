/**
 * A HELPER WHOSE TIMEOUT IS A DEADLINE ON THE ANSWER, NOT A SIGNAL SENT AT IT.
 *
 * Every probe the swap freezer runs (`/bin/ps`, `/usr/sbin/lsof`,
 * `/bin/launchtl print`) used to be written the same way: spawn, `setTimeout` a
 * `proc.kill()`, then `await` the output. That timer is not a deadline. The kill
 * is a SIGTERM, the await stays on `stdout` until EOF, and a child blocked in the
 * kernel - `lsof` stat-ing every mount, which is the shape of the OrbStack NFS
 * hang that already froze this server once - neither dies nor closes the pipe.
 * Measured on this Mac with a child that ignores SIGTERM: `timeoutMs=1000` ->
 * settled after 6145 ms.
 *
 * That matters far beyond a slow beat. The freezer's `tick()` holds a `ticking`
 * latch for the whole beat and clears it in a `finally`; an await that never
 * settles means no later beat ever runs, and `thawPass` - the only place the ten
 * minute cap lives - is never called again. A tree stopped with SIGSTOP then
 * stays stopped for as long as the server lives. So the deadline here is what
 * bounds the freeze, and it is a `Promise.race`: the answer, or nothing.
 *
 * The SIGKILL after the SIGTERM is not belt-and-braces: without it the child
 * that ignored the first signal stays behind on every beat, one per 120 s, on
 * the machine that is already short of memory.
 */

/** Milliseconds between the SIGTERM at the deadline and the SIGKILL that follows it. */
const KILL_GRACE_MS = 250;

export interface Capture {
  text: string;
  exitCode: number | null;
}

/** The spawn itself, kept apart so its piped-stdout type survives a failure to start. */
function spawnWithPipe(argv: string[]) {
  try {
    return Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
}

/**
 * `argv` run with an ABSOLUTE path, its stdout captured, and `null` when it did
 * not answer in time - a timeout, a signal, or a spawn that threw. `null` is
 * never "it answered nothing": that distinction is the whole reason the callers
 * can tell a machine with no matching process from a machine that is thrashing.
 */
export async function captureWithDeadline(argv: string[], timeoutMs: number): Promise<Capture | null> {
  const proc = spawnWithPipe(argv);
  if (proc === null) return null;
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const answered = (async (): Promise<Capture> => {
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return { text, exitCode: proc.exitCode };
  })();
  // The loser of the race is still a live promise: without this an abandoned
  // rejection would surface as an unhandled one, seconds after the caller left.
  answered.catch(() => {});
  try {
    const deadline = new Promise<null>((resolve) => {
      killer = setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        const hard = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
        hard.unref?.();
        resolve(null);
      }, timeoutMs);
      killer.unref?.();
    });
    const result = await Promise.race([answered, deadline]);
    if (result === null || timedOut || proc.signalCode) return null;
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(killer);
  }
}
