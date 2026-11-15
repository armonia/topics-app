/**
 * ONE way to ask git a question from the server, with a real deadline.
 *
 * Several services used to carry their own copy of this runner and disagreed on
 * a timeout (124 in some, 1 in others). Exit 1 is a real answer for many
 * git commands (`merge-base --is-ancestor` reads it as "not an ancestor"), so a
 * timeout reported as 1 turns "git did not answer" into a verdict. Here a
 * timeout is ALWAYS 124 (the convention of `timeout(1)`): any code other than
 * 0 and 1 is "no answer".
 *
 * A failed spawn (no `git` on PATH) and an exception thrown while preparing
 * the call answer 1 with the reason in `stderr`. The directory goes through
 * `git -C`, so a missing `cwd` is git's own answer (128, "cannot change to"),
 * not a spawn failure: the old identity runner passed it as the spawn `cwd`
 * and answered 1 "ENOENT". Callers read 128 as "no answer", which is safer.
 */
import { runBounded } from "./bounded-spawn";
import { gitEnvFor } from "./git-identity";

export interface RunGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunGitOptions {
  /** Deadline for the whole answer, in ms (see `SPAWN_TIMEOUT`). */
  timeoutMs: number;
  /**
   * Launch git with a committer identity where the machine has none
   * (`gitEnvFor`): needed by callers that CREATE commits, since git without an
   * identity exits 128 before touching the tree.
   */
  identity?: boolean;
  /** Extra variables merged over the environment. */
  env?: Record<string, string>;
}

/** Exit code reported when the deadline fired before git answered. */
export const GIT_TIMEOUT_CODE = 124;

export async function runGit(cwd: string, args: string[], opts: RunGitOptions): Promise<RunGitResult> {
  try {
    const base = opts.identity ? await gitEnvFor(cwd) : undefined;
    const env = base || opts.env ? { ...(base ?? process.env), ...(opts.env ?? {}) } : undefined;
    const r = await runBounded(["git", "-C", cwd, ...args], {
      stderr: "pipe",
      timeoutMs: opts.timeoutMs,
      ...(env ? { env } : {}),
    });
    if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
    // A timeout leaves stderr empty: name it, or callers report "no reason".
    return { code: r.exitCode ?? GIT_TIMEOUT_CODE, stdout: r.stdout, stderr: r.stderr || (r.timedOut ? "timeout" : "") };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
