/**
 * The git runner for operations that CREATE commits: it runs `git <args>` in
 * `cwd` with the signing identity of `gitEnvFor` (git without one exits 128
 * before touching the tree), under a bounded deadline.
 *
 * One definition of the exit codes, shared by the land and the residue save:
 * a deadline is 124 (the `timeout(1)` convention, "no answer"), never 1, which
 * callers read as a verified negative; a process that did not start is 1 with
 * the error in stderr.
 */
import { runBounded } from "./bounded-spawn";
import { gitEnvFor } from "./git-identity";

export interface GitIdentityRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runGitWithIdentity(cwd: string, args: string[], timeoutMs: number): Promise<GitIdentityRunResult> {
  try {
    const env = await gitEnvFor(cwd);
    const r = await runBounded(["git", ...args], { cwd, stderr: "pipe", env, timeoutMs });
    if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
    return { code: r.exitCode ?? 124, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
