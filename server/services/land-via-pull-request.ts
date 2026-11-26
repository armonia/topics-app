/**
 * LAND A CARD BY LETTING GITHUB MERGE THE PULL REQUEST THAT ALREADY TESTED IT.
 *
 * WHY IT EXISTS. The programmatic land used to merge the card's branch into the
 * LOCAL main and push that merge commit straight to origin. That push is a
 * GitHub Actions `push` event, and its tree was never measured by a `pull_request`
 * run, so `tree-verdict` (scripts/ci-changes.ts, the `changes` job of
 * .github/workflows/ci.yml) cannot recognize it and main reruns the whole CI.
 * Measured on topics-app: 14 of 24 `main` runs came from a land or a direct push
 * with no pull_request run behind them.
 *
 * By the time a card is allowed to land, `ci-evidence.ts` has already opened (or
 * reused) a draft pull request for this branch and waited for its CI to go
 * green, which leaves the tree-verdict annotation on that pull_request run. So
 * instead of merging locally, this module reuses that same pull request: makes
 * it ready, turns on GitHub's own auto-merge with a MERGE COMMIT (never squash
 * or rebase, since only a merge commit's tree matches the one the pull_request
 * run already tested), waits for GitHub to actually merge it, and then fast
 * forwards local main onto the commit GitHub produced.
 *
 * `{ status: "head-differs" }` is not a failure either: the pull request's head
 * is not the commit the caller wants merged (realign commits only the local
 * branch has, or a measured sha that moved), so GitHub would merge the wrong
 * tree or never merge it. The caller falls back to the local merge.
 *
 * `{ status: "main-ahead" }` is not a failure either: local main holds commits
 * origin does not have yet (a land not pushed), so GitHub's merge commit could
 * not be fast forwarded here and the two mains would diverge. The caller falls
 * back to the local merge, which publishes both together.
 *
 * On a timeout the module turns GitHub's auto-merge back off, so the pull
 * request cannot merge later behind a land that already reported failure.
 *
 * `{ status: "no-pr" }` is not a failure: a branch with no open pull request
 * (ci-evidence never ran for it, or it was closed already) falls back to the
 * caller's own local-merge-and-push path, which this module never replaces.
 */
import { runGit } from "../lib/run-git";
import type { GithubPort } from "./ci-evidence";

export type LandViaPrResult =
  /** `baseMoved` is set when the first parent of GitHub's merge commit is not the origin/main read at enable time: the tree is not the tested one. */
  | { status: "merged"; commit: string; baseMoved?: { expected: string; actual: string } }
  | { status: "no-pr" }
  /** The pull request exists but its head is not the commit the caller means to land: GitHub would merge something else. */
  | { status: "head-differs"; prHead: string | null; expected: string }
  /** Local main has commits origin lacks: GitHub's merge commit would not fast forward onto it. */
  | { status: "main-ahead" }
  /** The pull request's base is not the current origin/main: GitHub would merge onto another base, a tree nobody tested. */
  | { status: "base-differs"; prBase: string | null; originMain: string }
  | { status: "failed"; reason: string };

export type FastForwardMain = (cwd: string, commit: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** True when local HEAD is already contained in origin/main (after a fetch), so a merge GitHub makes there fast forwards here. */
export type MainIsBehindOrigin = (cwd: string) => Promise<{ ok: true; behind: boolean; originMain: string } | { ok: false; reason: string }>;

export type LandViaPrDeps = {
  mainIsBehindOrigin?: MainIsBehindOrigin;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  deadlineMs?: number;
  fastForwardMain?: FastForwardMain;
  /** First parent of a commit, to compare it with the base read at enable time. Default: git. */
  firstParent?: (cwd: string, commit: string) => Promise<string | null>;
};

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const GIT_TIMEOUT_MS = 30_000;

const realMainIsBehindOrigin: MainIsBehindOrigin = async (cwd) => {
  const fetch = await runGit(cwd, ["fetch", "origin", "main"], { timeoutMs: GIT_TIMEOUT_MS });
  if (fetch.code !== 0) return { ok: false, reason: `git fetch origin main exited ${fetch.code}: ${fetch.stderr.trim().slice(0, 300)}` };
  const ancestor = await runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { timeoutMs: GIT_TIMEOUT_MS });
  // 0 = ancestor, 1 = not; anything else is git failing to answer.
  if (ancestor.code === 0 || ancestor.code === 1) {
    const tip = await runGit(cwd, ["rev-parse", "origin/main"], { timeoutMs: GIT_TIMEOUT_MS });
    if (tip.code !== 0) return { ok: false, reason: `git rev-parse origin/main exited ${tip.code}: ${tip.stderr.trim().slice(0, 300)}` };
    return { ok: true, behind: ancestor.code === 0, originMain: tip.stdout.trim() };
  }
  return { ok: false, reason: `git merge-base --is-ancestor exited ${ancestor.code}: ${ancestor.stderr.trim().slice(0, 300)}` };
};

const realFirstParent = async (cwd: string, commit: string): Promise<string | null> => {
  const r = await runGit(cwd, ["rev-parse", `${commit}^1`], { timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 ? r.stdout.trim() : null;
};

/** gh missing (exit 127) or not logged in: there is no pull request path on this machine, only the local merge. */
const GH_UNAVAILABLE = /exited 127|ENOENT|not found|gh auth login|not logged in|authenticat/i;

/** Real git fetch + fast-forward of local main onto the commit GitHub produced. */
const realFastForwardMain: FastForwardMain = async (cwd, commit) => {
  const fetch = await runGit(cwd, ["fetch", "origin", "main"], { timeoutMs: GIT_TIMEOUT_MS });
  if (fetch.code !== 0) return { ok: false, reason: `git fetch origin main exited ${fetch.code}: ${fetch.stderr.trim().slice(0, 300)}` };
  const ff = await runGit(cwd, ["merge", "--ff-only", commit], { timeoutMs: GIT_TIMEOUT_MS });
  if (ff.code !== 0) return { ok: false, reason: `git merge --ff-only ${commit} exited ${ff.code}: ${ff.stderr.trim().slice(0, 300)}` };
  return { ok: true };
};

/**
 * Reuses the branch's open pull request to land it through GitHub's own
 * auto-merge, then fast-forwards local main onto the resulting commit.
 *
 * `cwd` is the local checkout that must end up on that commit (the land's
 * worktree, parked on main): the caller is responsible for it being clean and
 * on main before calling this, exactly as it was before calling the old
 * local-merge path.
 */
export async function landViaPullRequest(
  input: { cwd: string; branch: string; mergeMessage: string; expectedHead: string },
  port: GithubPort,
  deps: LandViaPrDeps = {},
): Promise<LandViaPrResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const fastForwardMain = deps.fastForwardMain ?? realFastForwardMain;
  const mainIsBehindOrigin = deps.mainIsBehindOrigin ?? realMainIsBehindOrigin;
  deps = { ...deps, firstParent: deps.firstParent ?? realFirstParent };

  // A checkout whose origin is not a GitHub repo (or has none at all, e.g. a
  // test fixture) has nothing to reuse: the caller's local merge is the only path.
  const repoGot = await port.repo(input.cwd);
  if (!repoGot.ok) return { status: "no-pr" };
  const repo = repoGot.value;

  const open = await port.openPullRequest(input.cwd, repo, input.branch);
  if (!open.ok && GH_UNAVAILABLE.test(open.error)) return { status: "no-pr" };
  if (!open.ok) return { status: "failed", reason: `cannot look up the pull request of ${input.branch}: ${open.error}` };
  if (!open.value) return { status: "no-pr" };
  const pr = open.value.number;

  // Auto-merge may already be on (an earlier attempt, or an enable gh was killed
  // after): every "failed" exit after the lookup turns it off, or the pull request merges behind a land declared failed.
  const failOff = async (reason: string): Promise<LandViaPrResult> => {
    const off = await port.disableAutoMerge(input.cwd, repo, pr);
    return { status: "failed", reason: `${reason}, ${off.ok ? "auto-merge turned off" : `and auto-merge could not be turned off: ${off.error}`}` };
  };

  // GitHub merges the pull request's head, whatever the caller holds locally
  // (a realign commit, a newer pinned measurement): merge only that exact commit.
  if (open.value.headRefOid !== input.expectedHead) {
    return { status: "head-differs", prHead: open.value.headRefOid ?? null, expected: input.expectedHead };
  }

  const state = await port.pullRequestState(input.cwd, repo, pr);
  if (!state.ok) return failOff(`cannot read pull request #${pr}: ${state.error}`);

  // Already merged (a previous attempt enabled auto-merge and GitHub acted on
  // it before this land got to re-check): land what is already there.
  if (state.value.merged) {
    if (!state.value.mergeCommit) return { status: "failed", reason: `pull request #${pr} is merged but GitHub reports no merge commit` };
    return fastForwardAndReport(input.cwd, state.value.mergeCommit, fastForwardMain);
  }

  // Past this point GitHub merges on origin, which cannot be taken back: make
  // sure local main can follow it with a fast forward before asking.
  const behind = await mainIsBehindOrigin(input.cwd);
  if (!behind.ok) return failOff(behind.reason);
  if (!behind.behind) return { status: "main-ahead" };
  // Two lands in a row: the pull request was tested on a base origin/main has
  // since left, so GitHub would merge onto a new base and the tree would not be
  // the one measured (main would rerun the CI). Only the current base is safe.
  if (open.value.baseRefOid !== behind.originMain) {
    return { status: "base-differs", prBase: open.value.baseRefOid ?? null, originMain: behind.originMain };
  }

  if (state.value.isDraft) {
    const ready = await port.markReady(input.cwd, repo, pr);
    if (!ready.ok) return { status: "failed", reason: `cannot take pull request #${pr} out of draft: ${ready.error}` };
  }

  const auto = await port.enableAutoMerge(input.cwd, repo, pr, input.mergeMessage);
  if (!auto.ok) return failOff(`cannot enable auto-merge on pull request #${pr}: ${auto.error}`);

  const reportMerged = async (mergeCommit: string | null): Promise<LandViaPrResult> => {
    if (!mergeCommit) return { status: "failed", reason: `pull request #${pr} is merged but GitHub reports no merge commit` };
    const ff = await fastForwardAndReport(input.cwd, mergeCommit, fastForwardMain);
    if (ff.status !== "merged") return ff;
    // The base moved while GitHub waited for the CI: the merge landed on a tree nobody tested.
    const parent = await deps.firstParent?.(input.cwd, mergeCommit);
    if (parent && parent !== behind.originMain) return { status: "merged", commit: mergeCommit, baseMoved: { expected: behind.originMain, actual: parent } };
    return ff;
  };

  const deadline = now() + deadlineMs;
  while (true) {
    const poll = await port.pullRequestState(input.cwd, repo, pr);
    if (!poll.ok) return failOff(`cannot poll pull request #${pr}: ${poll.error}`);
    if (poll.value.merged) return reportMerged(poll.value.mergeCommit);
    if (now() >= deadline) {
      const minutes = Math.round(deadlineMs / 60_000);
      const off = await port.disableAutoMerge(input.cwd, repo, pr);
      // GitHub may have merged between the last poll and now: that is a land, not a failure.
      const last = await port.pullRequestState(input.cwd, repo, pr);
      if (last.ok && last.value.merged) return reportMerged(last.value.mergeCommit);
      const tail = off.ok ? "auto-merge turned off" : `and auto-merge could not be turned off: ${off.error}`;
      return { status: "failed", reason: `pull request #${pr} did not merge within ${minutes} min of auto-merge, ${tail}` };
    }
    await sleep(pollMs);
  }
}

async function fastForwardAndReport(cwd: string, commit: string, fastForwardMain: FastForwardMain): Promise<LandViaPrResult> {
  const ff = await fastForwardMain(cwd, commit);
  if (!ff.ok) return { status: "failed", reason: ff.reason };
  return { status: "merged", commit };
}
