/**
 * @covers LAND-21
 */
import { describe, expect, test } from "bun:test";
import { landViaPullRequest } from "./land-via-pull-request";
import type { GithubPort } from "./ci-evidence";

const input = { cwd: "/tmp/wt", branch: "topics/card", mergeMessage: "merge task abc: title", expectedHead: "h".repeat(40) };

function fakePort(over: Partial<GithubPort> = {}): GithubPort {
  return {
    ownCommits: async () => ({ ok: true, value: 1 }),
    branch: async () => ({ ok: true, value: "topics/card" }),
    repo: async () => ({ ok: true, value: "o/r" }),
    push: async () => ({ ok: true, value: "pushed" }),
    remoteHead: async () => ({ ok: true, value: null }),
    inReflog: async () => ({ ok: true, value: false }),
    contains: async () => ({ ok: true, value: false }),
    openPullRequest: async () => ({ ok: true, value: { number: 7, url: "https://github.com/o/r/pull/7", headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40) } }),
    draftPullRequest: async () => ({ ok: true, value: { number: 7, url: "https://github.com/o/r/pull/7" } }),
    closePullRequest: async () => ({ ok: true, value: "closed" }),
    deleteRemoteBranch: async () => ({ ok: true, value: "deleted" }),
    runs: async () => ({ ok: true, value: [] }),
    jobs: async () => ({ ok: true, value: [] }),
    mergeState: async () => ({ ok: true, value: "MERGEABLE" }),
    rerun: async () => ({ ok: true, value: undefined }),
    openPullRequests: async () => ({ ok: true, value: [] }),
    branchRuns: async () => ({ ok: true, value: [] }),
    cancelRun: async () => ({ ok: true, value: undefined }),
    markReady: async () => ({ ok: true, value: "ready" }),
    enableAutoMerge: async () => ({ ok: true, value: "enabled" }),
    disableAutoMerge: async () => ({ ok: true, value: "disabled" }),
    pullRequestState: async () => ({ ok: true, value: { isDraft: false, merged: false, mergeCommit: null } }),
    ...over,
  };
}

/** Local main already contained in origin/main: the precondition the real git check reports on a pushed main. */
const synced = { mainIsBehindOrigin: async () => ({ ok: true as const, behind: true, originMain: "b".repeat(40) }) };

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe("landViaPullRequest", () => {
  test("a checkout with no GitHub origin falls back to the caller's own merge path", async () => {
    const port = fakePort({ repo: async () => ({ ok: false, error: "origin is not a GitHub repository" }) });
    const got = await landViaPullRequest(input, port);
    expect(got).toEqual({ status: "no-pr" });
  });

  test("no open pull request falls back to the caller's own merge path", async () => {
    const port = fakePort({ openPullRequest: async () => ({ ok: true, value: null }) });
    const got = await landViaPullRequest(input, port);
    expect(got).toEqual({ status: "no-pr" });
  });

  test("a pull request whose head differs from the commit to land is not touched", async () => {
    const calls: string[] = [];
    const port = fakePort({
      openPullRequest: async () => ({ ok: true, value: { number: 7, url: "u", headRefOid: "o".repeat(40) } }),
      markReady: async () => { calls.push("ready"); return { ok: true, value: "ready" }; },
      enableAutoMerge: async () => { calls.push("auto"); return { ok: true, value: "enabled" }; },
    });
    const got = await landViaPullRequest(input, port);
    expect(got).toEqual({ status: "head-differs", prHead: "o".repeat(40), expected: "h".repeat(40) });
    expect(calls).toEqual([]);
  });

  test("a failed lookup is a failure, not a fallback", async () => {
    const port = fakePort({ openPullRequest: async () => ({ ok: false, error: "gh: timeout" }) });
    const got = await landViaPullRequest(input, port);
    expect(got).toEqual({ status: "failed", reason: expect.stringContaining("gh: timeout") });
  });

  test("a draft pull request is made ready before auto-merge is enabled", async () => {
    const calls: string[] = [];
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: true, merged: false, mergeCommit: null } }),
      markReady: async () => { calls.push("ready"); return { ok: true, value: "ready" }; },
      enableAutoMerge: async () => { calls.push("auto"); return { ok: true, value: "enabled" }; },
    });
    const ff = async () => ({ ok: true as const });
    await landViaPullRequest(input, port, { ...synced, ...fakeClock(), deadlineMs: 0, fastForwardMain: ff });
    expect(calls).toEqual(["ready", "auto"]);
  });

  test("polls until GitHub merges it, then fast-forwards main onto the merge commit", async () => {
    let polls = 0;
    const port = fakePort({
      pullRequestState: async () => {
        polls += 1;
        if (polls < 3) return { ok: true, value: { isDraft: false, merged: false, mergeCommit: null } };
        return { ok: true, value: { isDraft: false, merged: true, mergeCommit: "a".repeat(40) } };
      },
    });
    const fastForwarded: string[] = [];
    const got = await landViaPullRequest(input, port, {
      ...synced,
      ...fakeClock(),
      pollMs: 1,
      fastForwardMain: async (_cwd, commit) => { fastForwarded.push(commit); return { ok: true }; },
    });
    expect(got).toEqual({ status: "merged", commit: "a".repeat(40) });
    expect(fastForwarded).toEqual(["a".repeat(40)]);
    expect(polls).toBe(3);
  });

  test("already merged (a previous attempt enabled auto-merge and GitHub already acted) lands without touching the pull request again", async () => {
    const calls: string[] = [];
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: false, merged: true, mergeCommit: "b".repeat(40) } }),
      markReady: async () => { calls.push("ready"); return { ok: true, value: "ready" }; },
      enableAutoMerge: async () => { calls.push("auto"); return { ok: true, value: "enabled" }; },
    });
    const got = await landViaPullRequest(input, port, {
      fastForwardMain: async () => ({ ok: true }),
    });
    expect(got).toEqual({ status: "merged", commit: "b".repeat(40) });
    expect(calls).toEqual([]);
  });

  test("a merge commit missing from a merged pull request is a failure, never a made-up commit", async () => {
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: false, merged: true, mergeCommit: null } }),
    });
    const got = await landViaPullRequest(input, port);
    expect(got.status).toBe("failed");
  });

  test("checks still running: the land lets go at once and leaves auto-merge on", async () => {
    const calls: string[] = [];
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: false, merged: false, mergeCommit: null, checksPending: true } }),
      disableAutoMerge: async () => { calls.push("off"); return { ok: true, value: "disabled" }; },
    });
    const got = await landViaPullRequest(input, port, { ...synced, ...fakeClock(), pollMs: 1 });
    expect(got).toEqual({ status: "waiting-ci", pr: 7 });
    expect(calls).toEqual([]);
  });

  test("a deadline with no merge is a failure that names the pull request and turns auto-merge back off", async () => {
    const calls: string[] = [];
    const port = fakePort({ disableAutoMerge: async () => { calls.push("off"); return { ok: true, value: "disabled" }; } });
    const got = await landViaPullRequest(input, port, { ...synced, ...fakeClock(), pollMs: 1, deadlineMs: 1 });
    expect(got).toEqual({ status: "failed", reason: expect.stringContaining("#7") });
    expect(calls).toEqual(["off"]);
  });

  test("local main with commits origin lacks falls back before GitHub is asked to merge anything", async () => {
    const calls: string[] = [];
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: true, merged: false, mergeCommit: null } }),
      markReady: async () => { calls.push("ready"); return { ok: true, value: "ready" }; },
      enableAutoMerge: async () => { calls.push("auto"); return { ok: true, value: "enabled" }; },
    });
    const got = await landViaPullRequest(input, port, { mainIsBehindOrigin: async () => ({ ok: true, behind: false, originMain: "b".repeat(40) }) });
    expect(got).toEqual({ status: "main-ahead" });
    expect(calls).toEqual([]);
  });

  test("a pull request measured on an older base than origin/main falls back before GitHub merges anything", async () => {
    const calls: string[] = [];
    const port = fakePort({
      openPullRequest: async () => ({ ok: true, value: { number: 7, url: "u", headRefOid: "h".repeat(40), baseRefOid: "a".repeat(40) } }),
      markReady: async () => { calls.push("ready"); return { ok: true, value: "ready" }; },
      enableAutoMerge: async () => { calls.push("auto"); return { ok: true, value: "enabled" }; },
    });
    const got = await landViaPullRequest(input, port, synced);
    expect(got).toEqual({ status: "base-differs", prBase: "a".repeat(40), originMain: "b".repeat(40) });
    expect(calls).toEqual([]);
  });

  test("an unreadable pull request state turns auto-merge off before reporting the failure", async () => {
    const calls: string[] = [];
    const port = fakePort({
      pullRequestState: async () => ({ ok: false, error: "gh: boom" }),
      disableAutoMerge: async () => { calls.push("off"); return { ok: true, value: "disabled" }; },
    });
    const got = await landViaPullRequest(input, port, synced);
    expect(got).toEqual({ status: "failed", reason: expect.stringContaining("gh: boom") });
    expect(calls).toEqual(["off"]);
  });

  test("a fast-forward that fails (main moved under it) is a failure, not a silent partial land", async () => {
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: false, merged: true, mergeCommit: "c".repeat(40) } }),
    });
    const got = await landViaPullRequest(input, port, {
      fastForwardMain: async () => ({ ok: false, reason: "not possible to fast-forward" }),
    });
    expect(got).toEqual({ status: "failed", reason: "not possible to fast-forward" });
  });

  test("a failed poll after enabling auto-merge turns it off", async () => {
    const calls: string[] = [];
    let n = 0;
    const port = fakePort({
      pullRequestState: async () => (n++ === 0 ? { ok: true, value: { isDraft: false, merged: false, mergeCommit: null } } : { ok: false, error: "gh: poll boom" }),
      disableAutoMerge: async () => { calls.push("off"); return { ok: true, value: "disabled" }; },
    });
    const got = await landViaPullRequest(input, port, synced);
    expect(got).toEqual({ status: "failed", reason: expect.stringContaining("poll boom") });
    expect(calls).toEqual(["off"]);
  });

  test("an enable that errors (gh killed after the mutation) turns auto-merge off", async () => {
    const calls: string[] = [];
    const port = fakePort({
      enableAutoMerge: async () => ({ ok: false, error: "killed after 60 s" }),
      disableAutoMerge: async () => { calls.push("off"); return { ok: true, value: "disabled" }; },
    });
    const got = await landViaPullRequest(input, port, synced);
    expect(got.status).toBe("failed");
    expect(calls).toEqual(["off"]);
  });

  test("a failed origin fetch turns auto-merge off", async () => {
    const calls: string[] = [];
    const port = fakePort({ disableAutoMerge: async () => { calls.push("off"); return { ok: true, value: "disabled" }; } });
    const got = await landViaPullRequest(input, port, { mainIsBehindOrigin: async () => ({ ok: false, reason: "fetch failed" }) });
    expect(got.status).toBe("failed");
    expect(calls).toEqual(["off"]);
  });

  test("GitHub merging between the last poll and the deadline is a land, not a failure", async () => {
    const clock = fakeClock();
    let reads = 0;
    const port = fakePort({
      pullRequestState: async () => {
        reads++;
        // the first read is the lookup; the final re-read after the disable sees the merge
        const merged = reads >= 5;
        return { ok: true, value: { isDraft: false, merged, mergeCommit: merged ? "c".repeat(40) : null } };
      },
    });
    const got = await landViaPullRequest(input, port, {
      ...synced, ...clock, pollMs: 60_000, deadlineMs: 180_000,
      fastForwardMain: async () => ({ ok: true }), firstParent: async () => "b".repeat(40),
    });
    expect(got).toEqual({ status: "merged", commit: "c".repeat(40) });
  });

  test("a merge on a base that moved during the wait says so", async () => {
    const port = fakePort({
      pullRequestState: async () => ({ ok: true, value: { isDraft: false, merged: false, mergeCommit: null } }),
    });
    let n = 0;
    const withMerge = { ...port, pullRequestState: async () => (n++ < 2 ? { ok: true as const, value: { isDraft: false, merged: false, mergeCommit: null } } : { ok: true as const, value: { isDraft: false, merged: true, mergeCommit: "c".repeat(40) } }) };
    const got = await landViaPullRequest(input, withMerge, {
      ...synced, ...fakeClock(), fastForwardMain: async () => ({ ok: true }), firstParent: async () => "n".repeat(40),
    });
    expect(got).toEqual({ status: "merged", commit: "c".repeat(40), baseMoved: { expected: "b".repeat(40), actual: "n".repeat(40) } });
  });

  test("gh missing or not logged in falls back to the local merge", async () => {
    for (const error of ["gh pr list --repo exited 127: spawn gh ENOENT", "gh pr list exited 4: To get started with GitHub CLI, please run: gh auth login"]) {
      const got = await landViaPullRequest(input, fakePort({ openPullRequest: async () => ({ ok: false, error }) }));
      expect(got).toEqual({ status: "no-pr" });
    }
  });
});
