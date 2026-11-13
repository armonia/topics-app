import { describe, expect, test } from "bun:test";
import { supersedePreviousDelivery, type GithubRun, type OpenPullRequest } from "./ci-evidence";
import { fakePort, run } from "./ci-evidence.testkit";

const pr = (number: number, headRefName: string, card: string): OpenPullRequest => ({
  number, url: `https://github.com/o/r/pull/${number}`, headRefName, title: `board: ${headRefName} (card ${card})`,
});

describe("supersedePreviousDelivery", () => {
  const runsByBranch: Record<string, GithubRun[]> = {
    "topics/x": [run({ id: 101, status: "in_progress", conclusion: null, head_sha: "x1" }), run({ id: 102, status: "completed" })],
    "topics/other": [run({ id: 201, status: "in_progress", conclusion: null })],
    main: [run({ id: 301, status: "queued", conclusion: null })],
    "topics/y": [run({ id: 401, status: "queued", conclusion: null, head_sha: "old" }), run({ id: 402, status: "queued", conclusion: null, head_sha: "new" })],
  };

  test("closes the old pull request of the card, cancels its live runs and touches nothing else", async () => {
    const closed: Array<{ n: number; comment: string }> = [];
    const cancelled: number[] = [];
    const { port } = fakePort({
      openPullRequests: async () => ({ ok: true, value: [pr(7, "topics/x", "12345678"), pr(8, "topics/other", "99999999"), pr(9, "main", "12345678"), pr(10, "topics/y", "12345678")] }),
      branchRuns: async (_repo, branch) => ({ ok: true, value: runsByBranch[branch] ?? [] }),
      closePullRequest: async (_cwd, _repo, n, comment) => { closed.push({ n, comment }); return { ok: true, value: "closed" }; },
      cancelRun: async (_repo, id) => { cancelled.push(id); return { ok: true, value: undefined }; },
    });
    const out = await supersedePreviousDelivery(port, { cwd: "/tmp", repo: "o/r", taskId: "12345678-card", branch: "topics/y", sha: "new", pr: { number: 11, url: "u" } });
    expect(closed.map((c) => c.n)).toEqual([7]);
    expect(closed[0]!.comment).toContain("Superseded by #11");
    // 101 is the old PR's live run, 401 an older commit on the same branch.
    expect(cancelled).toEqual([101, 401]);
    expect(cancelled).not.toContain(201); // another card
    expect(cancelled).not.toContain(301); // main
    expect(cancelled).not.toContain(402); // the current commit
    expect(out.closed).toEqual([7]);
  });
});
