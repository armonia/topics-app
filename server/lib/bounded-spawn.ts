/**
 * AN EXTERNAL PROCESS WITH A REAL DEADLINE, for the path of a request.
 *
 * `Bun.spawn(...)` followed by `await new Response(proc.stdout).text()` waits
 * for the end of the STREAM, not for the end of the process: if the child
 * spawns a grandchild that inherits the pipe (git launching ssh, a hook or a
 * credential helper; a shell launching `sleep`) and the child is killed, the
 * grandchild keeps the pipe open and the request hangs until it dies on its
 * own. Measured with `sh -c "trap '' TERM; sleep 30"` and Bun 1.4's `timeout`
 * option: the answer comes back after 30005 ms, not after 300. The same holds
 * for a `setTimeout(() => proc.kill())` followed by an await on the stream
 * (which is what `runNetworkGit` did).
 *
 * `spawnBounded` replaces `Bun.spawn` with the same shape of use (`stdout`,
 * `stderr`, `stdin`, `exited`, `exitCode`, `kill`) and a deadline that is a
 * limit on the ANSWER: the answer is complete when the child has exited AND its
 * pipes have reached their end. When the deadline fires first it stops the whole
 * process group (the child starts in a group of its own, `detached`, so whoever
 * holds the pipe goes with it): SIGTERM, so git drops its lock files and a
 * script's `trap` runs, then SIGKILL after a short grace to whoever remains. It
 * then CLOSES the streams, so every await on the text or on `exited` settles.
 * `timedOut` is true and `exitCode` null whatever the child's own status was:
 * callers that look at `exitCode !== 0` read the deadline as a failure.
 * `kill()` with no argument is SIGTERM, as in `Bun.spawn`. The groups still
 * alive when the server exits are closed by its exit hook (see `liveGroups`).
 *
 * Environment variable `TOPICS_SPAWN_TIMEOUT_CAP_MS`: a ceiling applied to
 * EVERY deadline. It exists for the tests (a fake git that never answers must
 * not make them wait 60 seconds); it is not a knob for normal use.
 */

/** Reference deadlines, so callers do not spell them out by hand. */
export const SPAWN_TIMEOUT = {
  /** A question to git or `ps` about a local tree: rev-parse, status, diff, log. */
  query: 30_000,
  /** A local git write: add, reset, checkout, switch. */
  write: 120_000,
  /** Commit: may run slow hooks. */
  commit: 300_000,
  /** Worktree operations (add, remove, merge): they touch many files and run queued, not in a hot route. */
  long: 600_000,
} as const;

/** After SIGKILL, how long to wait before giving up on the streams of a child that no signal can move (D state). */
const CLOSE_GRACE_MS = 250;

/**
 * Between the polite signal and the forced one. SIGTERM lets git remove its
 * `index.lock` / worktree lock and lets a script's `trap` cleanup run; SIGKILL
 * does neither (`git add` killed with SIGKILL leaves `.git/index.lock` behind,
 * `git worktree add` leaves the worktree "locked initializing" and neither
 * `remove --force` nor `prune` takes it away). Two seconds is long enough for
 * those cleanups and short enough to keep the answer close to its deadline.
 */
export const TERM_GRACE_MS = 2_000;

function cappedMs(timeoutMs: number): number {
  const cap = Number(process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS);
  return Number.isFinite(cap) && cap > 0 ? Math.min(timeoutMs, cap) : timeoutMs;
}

/**
 * THE GROUPS THAT ARE STILL ALIVE, so that the server's shutdown can close them.
 *
 * The child is `detached` (a group of its own: the deadline kills the whole
 * tree), so it is NOT in the server's group any more. `scripts/topics-host/
 * topics-host.c` forwards launchd's SIGTERM to the server's whole group
 * (`kill(-child_pid, sig)`): with `Bun.spawn` the children died with it, with a
 * detached one they would survive with ppid 1, and with no deadline either (the
 * timer died with the server). The server cannot be stopped from outside by
 * group any more, so it closes its own: when the process exits (every path of
 * `gracefulShutdown` ends in `process.exit`) the groups still alive get SIGTERM,
 * a short sync grace, then SIGKILL. A SIGKILL on the server itself still leaves
 * them, exactly as it left a `Bun.spawn` child.
 *
 * Why a registry and not "no `detached`, kill the tree photographed with `ps`":
 * the group kill is what makes the deadline reach a grandchild that has
 * reparented or double-forked inside the tree, and a `ps` snapshot would be a
 * second process launched on the way out, with the very hang risk this file
 * exists to remove.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
/** Grace between SIGTERM and SIGKILL at shutdown: synchronous, so it is short. */
const SHUTDOWN_GRACE_MS = 500;

function groupExists(pid: number): boolean {
  if (pid <= 1) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/** SIGTERM, a short grace, SIGKILL to every group a `spawnBounded` left alive. Safe to call twice. */
export function reapBoundedGroups(graceMs: number = SHUTDOWN_GRACE_MS): number {
  const alive = [...liveGroups].filter(groupExists);
  liveGroups.clear();
  if (alive.length === 0) return 0;
  for (const pid of alive) { try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ } }
  Bun.sleepSync(graceMs);
  for (const pid of alive) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  return alive.length;
}

function trackGroup(pid: number): void {
  for (const old of liveGroups) if (!groupExists(old)) liveGroups.delete(old); // an id that is gone may be recycled
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => { reapBoundedGroups(); });
  }
}

export interface SpawnBoundedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** `pipe` to write by hand, or the bytes to hand over right away (stdin is then closed). */
  stdin?: "pipe" | "ignore" | "inherit" | Uint8Array;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
  /** Deadline on the answer, in milliseconds (see `SPAWN_TIMEOUT`). */
  timeoutMs: number;
  /** Time between SIGTERM and SIGKILL once the deadline fires (default `TERM_GRACE_MS`; capped like the deadline). */
  graceMs?: number;
}

export interface BoundedProcess {
  readonly pid: number;
  readonly stdin: { write(data: string | Uint8Array): unknown; end(): unknown } | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Settles at the end of the process OR at the deadline, never after. */
  readonly exited: Promise<number | null>;
  /** `null` if the process died of a signal (the deadline's included). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  kill(signal?: NodeJS.Signals | number): void;
}

const EMPTY = (): ReadableStream<Uint8Array> => new ReadableStream({ start: (c) => c.close() });

/**
 * The stream of `src`, closing by itself when the deadline fires. It reads in
 * chunks, so the text that arrived up to then is not lost. `done` settles when
 * the pipe has reached its end (every writer closed it), when it failed, was
 * cancelled, or the deadline closed it: "the stream is finished" is half of
 * what makes an answer complete (see `spawnBounded`).
 *
 * The queue has no high-water mark on purpose: it drains the pipe as fast as it
 * comes, like `Bun.spawn`'s own stream (measured: 20 MB written by a child that
 * is awaited BEFORE its stdout is read still finishes). With the default mark of
 * one chunk the end of the pipe would only be seen when somebody reads, and
 * `await proc.exited; await text()` (a pattern in the callers) would wait for the
 * deadline.
 */
function untilDeadline(
  src: ReadableStream<Uint8Array> | undefined | null,
  deadline: Promise<void>,
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  if (!src || typeof src === "number") return { stream: EMPTY(), done: Promise.resolve() };
  const reader = src.getReader();
  let over = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  void deadline.then(() => { over = true; finish(); });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await Promise.race([
          reader.read(),
          deadline.then(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>),
        ]);
        if (next.done || over) {
          controller.close();
          void reader.cancel().catch(() => {});
          finish();
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.close();
        finish();
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
      finish();
    },
  }, { highWaterMark: Infinity });
  return { stream, done };
}

/** Throws if the process cannot start (missing binary, missing cwd), exactly like `Bun.spawn`. */
export function spawnBounded(argv: string[], opts: SpawnBoundedOptions): BoundedProcess {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string> | undefined,
    stdin: opts.stdin ?? "ignore",
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "ignore",
    detached: true,
  });

  trackGroup(proc.pid);
  let timedOut = false;
  let fireDeadline!: () => void;
  const deadline = new Promise<void>((resolve) => { fireDeadline = resolve; });

  const killGroup = (signal: NodeJS.Signals | number): void => {
    if (proc.pid > 1) {
      try { process.kill(-proc.pid, signal); return; } catch { /* group already gone: fall back to the child */ }
    }
    try { proc.kill(signal); } catch { /* already dead */ }
  };
  const groupAlive = (): boolean => {
    if (proc.pid <= 1) return false;
    try { process.kill(-proc.pid, 0); return true; } catch { return false; }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    // Polite first: SIGTERM lets git drop its lock files and a script's `trap` run.
    killGroup("SIGTERM");
    const escalate = setTimeout(() => {
      // Whoever is still in the group after the grace is forced. If the group
      // is already gone there is nothing to force (and no signal to send to a
      // recycled id).
      if (groupAlive()) killGroup("SIGKILL");
      // The group is dead: the pipes close by themselves. The margin covers a
      // child in D state, which no signal moves: whoever waits returns anyway.
      const close = setTimeout(fireDeadline, CLOSE_GRACE_MS);
      close.unref?.();
    }, cappedMs(opts.graceMs ?? TERM_GRACE_MS));
    escalate.unref?.();
  }, cappedMs(opts.timeoutMs));
  timer.unref?.();

  const out = untilDeadline(proc.stdout as ReadableStream<Uint8Array> | undefined, deadline);
  const err = untilDeadline(proc.stderr as ReadableStream<Uint8Array> | undefined, deadline);
  // THE DEADLINE LIMITS THE ANSWER, not the direct child: the answer is complete
  // when the child has exited AND its pipes have reached their end. A child that
  // exits at once and leaves a grandchild holding the pipe (`cmd &`, a deploy
  // script that backgrounds something) used to switch the timer off with its
  // own exit and the caller waited for the grandchild to die on its own.
  // When the deadline fires first, the call is a timeout whatever the direct
  // child's exit status was: `timedOut` is true and `exitCode` is null, so a
  // caller that reads `exitCode !== 0` treats it as a failure.
  const answered = Promise.all([proc.exited, out.done, err.done]).then(([code]) => code);
  const exited: Promise<number | null> = Promise.race([
    answered.then((code) => (timedOut ? null : code)),
    deadline.then(() => null),
  ]).finally(() => {
    clearTimeout(timer);
    // The answer is over. A group with nobody left in it need not be reaped at
    // shutdown (and its id could be recycled by then); one that still has a
    // member (a daemon the child left behind) stays in the registry.
    if (!groupExists(proc.pid)) liveGroups.delete(proc.pid);
  });
  // A late rejection from the loser of the race must not become an unhandled one.
  exited.catch(() => {});

  return {
    pid: proc.pid,
    stdin: typeof proc.stdin === "object" && proc.stdin !== null ? (proc.stdin as BoundedProcess["stdin"]) : null,
    stdout: out.stream,
    stderr: err.stream,
    exited,
    get exitCode() { return timedOut ? null : proc.exitCode; },
    get timedOut() { return timedOut; },
    kill(signal) { killGroup(signal ?? "SIGTERM"); },
  };
}

export interface BoundedResult {
  stdout: string;
  stderr: string;
  /** `null` if the process was killed by a signal, the deadline included, or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** The process did not even start (missing binary, missing cwd). */
  spawnFailed: boolean;
}

/** Launches, reads everything, returns a result: for callers that do not need to touch the streams. */
export async function runBounded(
  argv: string[],
  opts: SpawnBoundedOptions & { stdinData?: string | Uint8Array },
): Promise<BoundedResult> {
  let proc: BoundedProcess;
  try {
    proc = spawnBounded(argv, { ...opts, stdin: opts.stdinData === undefined ? "ignore" : "pipe" });
  } catch {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, spawnFailed: true };
  }
  if (opts.stdinData !== undefined && proc.stdin) {
    try {
      proc.stdin.write(opts.stdinData);
      await proc.stdin.end();
    } catch { /* the child closed stdin before reading: its exit speaks for itself */ }
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode, timedOut: proc.timedOut, spawnFailed: false };
}
