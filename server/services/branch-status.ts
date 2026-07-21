/**
 * Branch state relative to `main`, read from the PROJECT repo so it stays
 * correct even after the worktree dir was removed (the ghost case). The worktree
 * GC uses it to decide when a branch holds nothing to lose.
 *
 * "merged" means "nothing unique to lose", TRUE in two cases:
 *   1. the branch tip is a git-ancestor of main (classic merge / fast-forward);
 *   2. the branch was SQUASH-landed — its tip is NOT an ancestor, but every
 *      unique SOURCE file it changed is already byte-identical on main.
 *
 * Case (2) is the fix for worktree/branch pile-up: squash landing is the default
 * path, so a landed task's branch is never a git-ancestor of main and, without
 * (2), leaks its worktree + branch forever (the "unmerged"-by-ancestry pile-up).
 *
 * Generated / lockfile / lockstep-version paths are ignored when comparing
 * content: they carry no task-unique work and every branch differs in them
 * (auto-bumped version, rebuilt bundle, relocked deps), so counting them would
 * make (2) never fire. A real dependency change always shows up in source too,
 * so ignoring the manifest stays safe — genuine work keeps the branch "unmerged".
 */

/** Generated, build-output, lockfile and lockstep-version paths — never unique work. */
const NOISE_RE =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|package\.json|tauri\.conf\.json|Cargo\.toml)$|(^|\/)(public|dist|node_modules)\//;

/** Drop generated/version/lock paths → only files whose diff would be real work. */
export function filterUniqueSourceFiles(paths: string[]): string[] {
  return paths.map((p) => p.trim()).filter((p) => p.length > 0 && !NOISE_RE.test(p));
}

async function gitExit(cwd: string, args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch { return 1; }
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch { return ""; }
}

export type BranchStatus = "gone" | "merged" | "unmerged";

export async function branchStatusFromRepo(
  repoPath: string,
  branch: string | null,
  mainRef = "main",
): Promise<BranchStatus> {
  if (!branch) return "gone";
  if ((await gitExit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== 0) return "gone";

  // (1) Classic ancestry: the tip is already on main.
  if ((await gitExit(repoPath, ["merge-base", "--is-ancestor", branch, mainRef])) === 0) return "merged";

  // The content comparison is only meaningful with a shared history; an
  // unrelated branch is left "unmerged" (never reaped by the GC).
  if ((await gitExit(repoPath, ["merge-base", branch, mainRef])) !== 0) return "unmerged";

  // (2) Squash-landed: `main...branch` is the branch's OWN changes since it
  // forked, so a branch merely BEHIND main (main evolved those files) still
  // shows a diff and stays "unmerged". If every unique source file it touched is
  // already identical on main, the branch holds nothing to lose.
  const changed = filterUniqueSourceFiles(
    (await gitOut(repoPath, ["diff", "--name-only", `${mainRef}...${branch}`])).split("\n"),
  );
  if (changed.length === 0) return "merged"; // only generated/version noise differs

  // `git diff --quiet` exits 0 when there is NO difference for the given paths.
  const differs = await gitExit(repoPath, ["diff", "--quiet", branch, mainRef, "--", ...changed]);
  return differs === 0 ? "merged" : "unmerged";
}
