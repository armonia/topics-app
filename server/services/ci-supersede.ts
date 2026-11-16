import type { GithubPort, GithubRun, PullRequestRef } from "./ci-evidence";

/** The tag `awaitCiEvidence` puts in the title of the draft it opens: the only link from a pull request back to its card. */
export const cardTag = (taskId: string): string => `(card ${taskId.slice(0, 8)})`;

const isLive = (run: GithubRun): boolean => run.status === "queued" || run.status === "in_progress" || run.status === "waiting" || run.status === "pending";

/**
 * A redelivery supersedes what the same card delivered before.
 *
 * `ci.yml` cancels in-progress runs by branch name only, so a card handed back
 * on a NEW branch left the old pull request and its run alive to the end, each
 * one holding runners the real runs queue behind. This closes the card's other
 * open pull requests ("superseded by #N") and cancels their live runs, and on
 * the same branch it cancels live runs of an older commit.
 *
 * THE CARD FILTER IS THE WHOLE SAFETY: a pull request is touched only when its
 * title carries this card's tag, and `main` is never a head. Housekeeping, so
 * it returns what it did and never throws; the branches are not deleted.
 */
export async function supersedePreviousDelivery(
  port: GithubPort,
  input: { cwd: string; repo: string; taskId: string; branch: string; sha: string; pr: PullRequestRef; baseBranch: string },
): Promise<{ closed: number[]; cancelled: number[]; problems: string[] }> {
  const out = { closed: [] as number[], cancelled: [] as number[], problems: [] as string[] };
  const { cwd, repo, branch, sha, pr, baseBranch } = input;
  const cancelLive = async (head: string, keep: (run: GithubRun) => boolean) => {
    const runs = await port.branchRuns(repo, head);
    if (!runs.ok) { out.problems.push(runs.error); return; }
    for (const r of runs.value) {
      if (!isLive(r) || !keep(r)) continue;
      const done = await port.cancelRun(repo, r.id);
      if (done.ok) out.cancelled.push(r.id);
      else out.problems.push(done.error);
    }
  };
  const open = await port.openPullRequests(cwd, repo);
  if (!open.ok) { out.problems.push(open.error); return out; }
  const tag = cardTag(input.taskId);
  const stale = open.value.filter((p) => p.title.includes(tag) && p.number !== pr.number
    && p.headRefName !== branch && p.headRefName !== baseBranch);
  for (const old of stale) {
    const closed = await port.closePullRequest(cwd, repo, old.number, `Superseded by #${pr.number}: the card was redelivered on \`${branch}\`.`);
    if (!closed.ok) { out.problems.push(closed.error); continue; }
    out.closed.push(old.number);
    await cancelLive(old.headRefName, () => true);
  }
  if (branch !== baseBranch) await cancelLive(branch, (r) => r.head_sha !== sha);
  return out;
}
