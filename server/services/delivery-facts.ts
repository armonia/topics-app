import type { GitRunner } from "./own-commits";

// Moved out of routes/nodes.ts, which sits at the repo's 800-line bloat limit.

/**
 * Where a delivery branch forked from, and how much is on it. `baseSha` is the
 * merge base with the default branch: it is what the origin board must already
 * have for the bundle to apply, and what it plants an empty branch on when the
 * card produced no commits.
 */
interface DeliveryFacts {
  baseSha: string | null;
  commitCount: number;
}

async function defaultBranchOf(runGit: GitRunner, repoPath: string): Promise<string> {
  const head = await runGit(repoPath, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  const remoteHead = head.stdout.trim();
  if (head.code === 0 && remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    const r = await runGit(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${candidate}`]);
    if (r.code === 0) return candidate;
  }
  return "main";
}

export async function deliveryFacts(runGit: GitRunner, repoPath: string, branch: string | null): Promise<DeliveryFacts> {
  const base = await defaultBranchOf(runGit, repoPath);
  const branchExists = branch
    ? (await runGit(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0
    : false;
  if (!branch || !branchExists) {
    const tip = await runGit(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${base}`]);
    return { baseSha: tip.code === 0 ? tip.stdout.trim() || null : null, commitCount: 0 };
  }
  const mb = await runGit(repoPath, ["merge-base", `refs/heads/${base}`, `refs/heads/${branch}`]);
  if (mb.code !== 0) return { baseSha: null, commitCount: 0 };
  const baseSha = mb.stdout.trim();
  const count = await runGit(repoPath, ["rev-list", "--count", `${baseSha}..refs/heads/${branch}`]);
  return { baseSha, commitCount: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0 };
}
