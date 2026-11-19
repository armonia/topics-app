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
): Promise<SupersedeOutcome> {
  const { cwd, repo, branch, sha, pr, baseBranch } = input;
  const out = await closeOtherRounds(port, {
    cwd, repo, taskId: input.taskId, branch, baseBranch, keep: pr.number,
    comment: `Superseded by #${pr.number}: the card was redelivered on \`${branch}\`.`,
  });
  if (branch !== baseBranch) await cancelLive(port, repo, branch, (r) => r.head_sha !== sha, out);
  return out;
}

type SupersedeOutcome = { closed: number[]; cancelled: number[]; problems: string[] };

async function cancelLive(port: GithubPort, repo: string, head: string, keep: (run: GithubRun) => boolean, out: SupersedeOutcome): Promise<void> {
  const runs = await port.branchRuns(repo, head);
  if (!runs.ok) { out.problems.push(runs.error); return; }
  for (const r of runs.value) {
    if (!isLive(r) || !keep(r)) continue;
    const done = await port.cancelRun(repo, r.id);
    if (done.ok) out.cancelled.push(r.id);
    else out.problems.push(done.error);
  }
}

/** The card's open pull requests on a head other than `branch` (never `main`, never `keep`): closed with `comment`, their live runs cancelled. */
async function closeOtherRounds(
  port: GithubPort,
  input: { cwd: string; repo: string; taskId: string; branch: string; baseBranch: string; keep?: number; comment: string },
): Promise<SupersedeOutcome> {
  const out: SupersedeOutcome = { closed: [], cancelled: [], problems: [] };
  const { cwd, repo, branch, baseBranch } = input;
  const open = await port.openPullRequests(cwd, repo);
  if (!open.ok) { out.problems.push(open.error); return out; }
  const tag = cardTag(input.taskId);
  const stale = open.value.filter((p) => p.title.includes(tag) && p.number !== input.keep
    && p.headRefName !== branch && p.headRefName !== baseBranch);
  for (const old of stale) {
    const closed = await port.closePullRequest(cwd, repo, old.number, input.comment);
    if (!closed.ok) { out.problems.push(closed.error); continue; }
    out.closed.push(old.number);
    await cancelLive(port, repo, old.headRefName, () => true, out);
  }
  return out;
}

/**
 * A NEW ROUND ON A NEW BRANCH ENDS THE PULL REQUESTS OF THE ROUNDS BEFORE IT.
 *
 * `supersedePreviousDelivery` fires only once the new round has opened its own
 * pull request, which is after its local commands are green and its push is
 * done. A card that came back to its agent and restarted on a new branch
 * often never gets there - `gates:fast` red, a round cut by a restart, an
 * agent still working - and the pull request of the previous round stayed
 * open with its run holding runners: 18 of them closed by hand on 18/11/2026,
 * each with a card already on another branch. So the round closes them the
 * moment it starts, from the branch its checkout is on. Same card filter as
 * above; a checkout on `main` or on no branch touches nothing.
 */
export async function supersedeEarlierRounds(
  port: GithubPort,
  input: { cwd: string; taskId: string; baseBranch: string },
): Promise<SupersedeOutcome> {
  const none: SupersedeOutcome = { closed: [], cancelled: [], problems: [] };
  const branch = await port.branch(input.cwd);
  if (!branch.ok) return { ...none, problems: [branch.error] };
  if (!branch.value || branch.value === input.baseBranch) return none;
  const repo = await port.repo(input.cwd);
  if (!repo.ok) return { ...none, problems: [repo.error] };
  return closeOtherRounds(port, {
    cwd: input.cwd, repo: repo.value, taskId: input.taskId, branch: branch.value, baseBranch: input.baseBranch,
    comment: `Superseded: the card started a new round on \`${branch.value}\`, this pull request belonged to an earlier one.`,
  });
}

