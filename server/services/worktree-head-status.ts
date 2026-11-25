/**
 * IS A `reuse` OR `detached` CHECKOUT ALREADY ON MAIN? (change worktree-standard)
 *
 * The sweep used to read every row that is not a `branch` row as merged: those rows were
 * either other tools' checkouts outside the root (kept as foreign) or short-lived
 * ones Topics made. Since the root pass registers orphan folders and the by-hand
 * move brings foreign worktrees into the root, a clean checkout of someone's
 * branch, or a detached HEAD whose commits live nowhere else, was reaped as if it
 * held nothing. This answers the question for real.
 *
 *   folder gone, or no project      -> merged (the removal can only drop the row)
 *   unborn HEAD (git answers, no commit yet) -> merged (there is no commit to lose)
 *   git fails, times out, or is not a repository here (a worktree whose
 *   registration git lost answers 128 "not a git repository") -> unmerged
 *   a row whose HEAD is still on its stored branch -> the branch's own status (squash lands included)
 *   (a checkout adopted on `feat` and later detached, with commits on top, is judged
 *   by its HEAD: the stored branch says nothing about what the folder holds now)
 *   otherwise                       -> HEAD is an ancestor of the published main?
 *   git cannot tell                 -> unmerged (whoever could not look keeps)
 */
import { existsSync } from "node:fs";
import type { GitRunner } from "./own-commits";
import { commitIsIn } from "./own-commits";
import { branchStatusFromRepo, publishedMainRef } from "./branch-status";

export interface HeadStatusRow {
  absPath: string;
  branchName: string | null;
  mode: "branch" | "reuse" | "detached";
}

export async function headStatusOfCheckout(
  row: HeadStatusRow,
  repoPath: string | null | undefined,
  git: GitRunner,
): Promise<"merged" | "unmerged"> {
  if (!repoPath || !existsSync(row.absPath)) return "merged";
  const head = await git(row.absPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => null);
  // `--verify --quiet` exits 1 with nothing on stdout only when the repository
  // answered and HEAD names no commit yet. Every other failure (128 not a
  // repository, 124 timeout, a spawn error) means nobody looked: keep.
  if (!head) return "unmerged";
  if (head.code === 1 && head.stdout.trim() === "") return "merged";
  const sha = head.code === 0 ? head.stdout.trim() : "";
  if (!sha) return "unmerged";
  if (row.mode !== "detached" && row.branchName && await headIsOnBranch(row.absPath, row.branchName, git)) {
    const s = await branchStatusFromRepo(repoPath, row.branchName).catch(() => "unmerged" as const);
    if (s === "merged") return "merged";
    if (s === "unmerged") return "unmerged";
  }
  const main = await publishedMainRef(repoPath, git);
  return (await commitIsIn(repoPath, sha, main, { runGit: git })) === true ? "merged" : "unmerged";
}

/**
 * HEAD left the row's stored branch (detached, or another branch) for commits
 * that are not on main: the folder is their only copy, whatever the branch says.
 * A merged or deleted branch, or a branch kept by a free-checkout, holds none of them.
 */
export async function headHoldsCommitsOffBranch(
  row: { absPath: string; branchName: string | null },
  repoPath: string,
  git: GitRunner,
): Promise<boolean> {
  if (!row.branchName || !existsSync(row.absPath)) return false;
  if (await headIsOnBranch(row.absPath, row.branchName, git)) return false;
  return (await headStatusOfCheckout({ ...row, mode: "detached" }, repoPath, git)) === "unmerged";
}

/** HEAD in this checkout is the stored branch itself, not a detached or other one. */
async function headIsOnBranch(absPath: string, branchName: string, git: GitRunner): Promise<boolean> {
  const ref = await git(absPath, ["symbolic-ref", "-q", "HEAD"]).catch(() => null);
  return !!ref && ref.code === 0 && ref.stdout.trim() === `refs/heads/${branchName}`;
}
