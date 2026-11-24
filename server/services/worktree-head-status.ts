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
 *   no readable HEAD                -> merged (not a checkout: no commit to lose)
 *   `reuse` with a branch that exists -> the branch's own status (squash lands included)
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
  const sha = head && head.code === 0 ? head.stdout.trim() : "";
  if (!sha) return "merged";
  if (row.mode === "reuse" && row.branchName) {
    const s = await branchStatusFromRepo(repoPath, row.branchName).catch(() => "unmerged" as const);
    if (s === "merged") return "merged";
    if (s === "unmerged") return "unmerged";
  }
  const main = await publishedMainRef(repoPath, git);
  return (await commitIsIn(repoPath, sha, main, { runGit: git })) === true ? "merged" : "unmerged";
}
