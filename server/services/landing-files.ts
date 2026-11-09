/**
 * The paths an automatic land would bring to main: what the merge carries, not
 * what the own-commit count remembers.
 *
 * `ownBranchFiles` (routes/tasks.ts) walks `listOwnCommits`, which leaves out
 * the commit the pruning writes to save a dirty worktree (`RESIDUE_SUBJECT`) and
 * every commit another local branch can reach. The merge brings both, so a
 * path-based verdict built on that walk can miss a file that lands. Here the
 * answer is the diff between the merge base with main and the tip: the files
 * whose content the merge adds, changes or removes, nothing left out.
 *
 * `tip` is the exact commit the land will merge (the card's delivery commit), so
 * the verdict is about the object that lands and not about a branch name that
 * can move under it. A branch name still works, for callers with no commit.
 *
 * `--no-renames` so a rename shows both paths; `null` = git could not answer,
 * and a land that does not know what it changes does not happen.
 */
import { defaultRunGit, type GitRunner } from "./own-commits";

const HEX_SHA = /^[0-9a-f]{7,64}$/i;

export async function landingFiles(
  repoPath: string,
  tip: string,
  opts: { mainRef?: string; runGit?: GitRunner } = {},
): Promise<string[] | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const target = tip.trim();
  if (!target) return null;
  // `refs/heads/` so a branch named like a file cannot make the range ambiguous;
  // a commit is used as git resolves it (the full sha, even if given abbreviated).
  let end = `refs/heads/${target}`;
  if (HEX_SHA.test(target)) {
    const commit = await run(repoPath, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
    if (commit.code === 0 && commit.stdout.trim()) end = commit.stdout.trim();
  }
  const res = await run(repoPath, ["diff", "--name-only", "--no-renames", "-z", `refs/heads/${mainRef}...${end}`, "--"]);
  if (res.code !== 0) return null;
  return res.stdout.split("\0").filter((p) => p.length > 0);
}
