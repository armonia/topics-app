/**
 * A CARD'S OWN BRANCH, ON ORIGIN BEFORE THE CARD LEAVES THIS MACHINE.
 *
 * A card sent back after a review already has a branch here: the one it
 * delivered on (`tasks.delivery_branch`, e.g. `topics/endless-calf`), kept as
 * `tasks.prior_branch` when going back to the queue clears the delivery
 * snapshot (`carriedBranch`). Run on another machine
 * (a paired node, Cloud Claude) it must start FROM that branch, and the other
 * machine only sees what origin has. On 30/10/2026 df5fd8c5 moved to the cloud
 * restarted from main without the three commits of its branch, and its delivery
 * conflicted with them on five files at the land.
 *
 * So the branch is pushed first, plainly (never forced): a branch origin already
 * has at the same tip is a no-op, one this checkout is ahead on is
 * fast-forwarded, one that diverged is refused, and the card stays here.
 */
import { runBounded, SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import type { GitRunner } from "./own-commits";

/**
 * The branch a card's next run starts from: its live delivery branch, or the
 * one it had when it went back to the queue. `null` = none, the default branch.
 */
export function carriedBranch(task: { deliveryBranch?: string | null; priorBranch?: string | null }): string | null {
  return task.deliveryBranch?.trim() || task.priorBranch?.trim() || null;
}

export type BranchOnOrigin = { ok: true } | { ok: false; reason: string };

/** The real git: bounded, no prompt for credentials (a prompt nobody answers is a hang). */
export const branchGit: GitRunner = async (cwd, args) => {
  const r = await runBounded(["git", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe", timeoutMs: SPAWN_TIMEOUT.commit,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
  return { code: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr || (r.timedOut ? "timeout" : "") };
};

/** A plain branch name: it becomes a git argument, so a dash or `..` is refused. */
export function isPlainBranchName(name: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock");
}

export async function ensureBranchOnOrigin(
  repoPath: string | null | undefined,
  branch: string,
  run: GitRunner = branchGit,
): Promise<BranchOnOrigin> {
  if (!repoPath) return { ok: false, reason: "il progetto non ha un checkout su questa macchina" };
  if (!isPlainBranchName(branch)) return { ok: false, reason: `«${branch}» non è un nome di ramo valido` };
  const local = await run(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code !== 0) {
    // Not in this checkout (pruned after a land, or born elsewhere): only origin can have it.
    const remote = await run(repoPath, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
    return remote.code === 0 ? { ok: true } : { ok: false, reason: "il ramo non c'è né qui né su origin" };
  }
  const push = await run(repoPath, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
  if (push.code === 0) return { ok: true };
  const why = (push.stderr || push.stdout).trim().split("\n").filter(Boolean).at(-1)?.slice(0, 160) ?? `exit ${push.code}`;
  return { ok: false, reason: `push rifiutato: ${why}` };
}
