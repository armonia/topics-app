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
    openPullRequest: async () => ({ ok: true, value: { number: 7, url: "https://github.com/o/r/pull/7", headRefOid: "h".repeat(40) } }),
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
const synced = { mainIsBehindOrigin: async () => ({ ok: true as const, behind: true }) };

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
    const got = await landViaPullRequest(input, port, { mainIsBehindOrigin: async () => ({ ok: true, behind: false }) });
    expect(got).toEqual({ status: "main-ahead" });
    expect(calls).toEqual([]);
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
});
