/**
 * The paths an automatic land would bring to main: what the merge carries, not
 * what the own-commit count remembers.
 *
 * `ownBranchFiles` (routes/tasks.ts) walks `listOwnCommits`, which leaves out
 * the commit the pruning writes to save a dirty worktree (`RESIDUE_SUBJECT`) and
 * every commit another local branch can reach. The merge brings both, so a
 * path-based verdict built on that walk can miss a file that lands. Here the
 * answer is the diff between the merge base with main and the branch tip: the
 * files whose content the merge adds, changes or removes.
 *
 * `--no-renames` so a rename shows both paths; `null` = git could not answer,
 * and a land that does not know what it changes does not happen.
 */
import { defaultRunGit, type GitRunner } from "./own-commits";

export async function branchLandingFiles(
  repoPath: string,
  branch: string,
  opts: { mainRef?: string; runGit?: GitRunner } = {},
): Promise<string[] | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  // `refs/heads/` so a branch named like a file cannot make the range ambiguous.
  const range = `refs/heads/${mainRef}...refs/heads/${branch}`;
  const res = await run(repoPath, ["diff", "--name-only", "--no-renames", "-z", range, "--"]);
  if (res.code !== 0) return null;
  return res.stdout.split("\0").filter((p) => p.length > 0);
}
