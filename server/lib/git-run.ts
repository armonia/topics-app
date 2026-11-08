/**
 * The two real git runners, one body each. They used to be copied in four
 * services and the copies disagreed on a deadline: two said 124 ("no answer"),
 * two said 1, which `commitIsIn` reads as "verified outside" and acts on.
 *
 * A timeout is never "exit 1". 124 is the convention of `timeout(1)`; any code
 * other than 0 and 1 means "could not answer".
 */
import { SPAWN_TIMEOUT, runBounded } from "./bounded-spawn";
import { gitEnvFor } from "./git-identity";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Read-only questions: `git -C <cwd>`, the short query deadline, optional extra env. */
export async function runGitQuery(cwd: string, args: string[], opts?: { env?: Record<string, string> }): Promise<RunResult> {
  const r = await runBounded(["git", "-C", cwd, ...args], {
    stderr: "pipe",
    timeoutMs: SPAWN_TIMEOUT.query,
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
  return { code: r.exitCode ?? 124, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Commands that may create commits: runs in `cwd` with the signer identity
 * filled in where it is missing (without one git exits 128 before touching the
 * tree, see `git-identity.ts`). `fetch` gets the short deadline, the rest the long one.
 */
export async function runGitSigned(cwd: string, args: string[]): Promise<RunResult> {
  try {
    const env = await gitEnvFor(cwd);
    const r = await runBounded(["git", ...args], {
      cwd,
      stderr: "pipe",
      env,
      timeoutMs: args[0] === "fetch" ? SPAWN_TIMEOUT.query : SPAWN_TIMEOUT.long,
    });
    if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
    return { code: r.exitCode ?? 124, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
