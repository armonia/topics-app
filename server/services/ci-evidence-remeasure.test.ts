/**
 * Which CI rows without a verdict are worth measuring again, and the pull
 * requests a new round ends.
 *
 * A row that ran out of time, or whose GitHub reads failed, says nothing about
 * the code and passes by itself: the same head measured again can still give a
 * verdict (`ciRemeasurable`). A dead end does not, and a real red is a verdict.
 * And a card that restarts on a new branch closes the pull requests of its
 * earlier rounds at the start of the round (`supersedeEarlierRounds`), not
 * only once its own draft is open.
 *
 * @covers KANBAN-93
 */
import { describe, expect, test } from "bun:test";
import { E2E_CI_CHECK, UNIT_CI_CHECK, type CheckRun } from "../../shared/board";
import { awaitCiEvidence, ciRemeasurable, type OpenPullRequest } from "./ci-evidence";
import { cardTag, supersedeEarlierRounds } from "./ci-supersede";
import { fakeClock, fakePort, input, run } from "./ci-evidence.testkit";
import { formatChecksComment, formatChecksThreadSummary } from "./review-checks";

const both = [UNIT_CI_CHECK, E2E_CI_CHECK];
const deps = (port: ReturnType<typeof fakePort>["port"], over: Record<string, unknown> = {}) => {
  const clock = fakeClock();
  return { port, now: clock.now, sleep: clock.sleep, stopping: () => false, pollMs: 60_000, deadlineMs: 10 * 60_000, ...over };
};

describe("ciRemeasurable", () => {
  test("a run still queued at the deadline is NOT MEASURED and transient", async () => {
    const { port } = fakePort({ runs: async () => ({ ok: true, value: [run({ status: "queued", conclusion: null })] }), jobs: async () => ({ ok: true, value: [] }) });
    const rows = await awaitCiEvidence({ ...input, checks: both }, deps(port));
    expect(rows.every((r) => r.notMeasured && r.transient)).toBe(true);
    expect(rows[0]!.tail).toContain("minutes after the push");
    expect(ciRemeasurable(rows)).toBe(true);
  });

  test("GitHub reads failing in a row are transient too", async () => {
    const { port } = fakePort({ runs: async () => ({ ok: false, error: "HTTP 502" }) });
    const rows = await awaitCiEvidence({ ...input, checks: both }, deps(port));
    expect(rows.every((r) => r.transient)).toBe(true);
    expect(ciRemeasurable(rows)).toBe(true);
  });

  test("a run cancelled again after its one rerun is a dead end, not transient", async () => {
    const { port } = fakePort({ runs: async () => ({ ok: true, value: [run({ conclusion: "cancelled", run_attempt: 2 })] }), jobs: async () => ({ ok: true, value: [] }) });
    const rows = await awaitCiEvidence({ ...input, checks: both }, deps(port));
    expect(rows.every((r) => r.notMeasured)).toBe(true);
    expect(rows.some((r) => r.transient)).toBe(false);
    expect(ciRemeasurable(rows)).toBe(false);
  });

  test("a pull request in conflict with main is a dead end", async () => {
    const { port } = fakePort({ runs: async () => ({ ok: true, value: [] }), mergeState: async () => ({ ok: true, value: "CONFLICTING" }) });
    const rows = await awaitCiEvidence({ ...input, checks: both }, deps(port, { noRunGraceMs: 0 }));
    expect(ciRemeasurable(rows)).toBe(false);
  });

  test("a real red next to a row that timed out is a verdict: nothing is measured again", () => {
    const red: CheckRun = { name: "e2e-ci", cmd: E2E_CI_CHECK.cmd, ok: false, code: 1, ms: 1, timedOut: false, tail: "e2e red" };
    const late: CheckRun = { name: "unit-ci", cmd: UNIT_CI_CHECK.cmd, ok: false, code: 97, ms: 1, timedOut: false, notMeasured: true, transient: true, tail: "NOT MEASURED" };
    expect(ciRemeasurable([late, red])).toBe(false);
    expect(ciRemeasurable([late])).toBe(true);
  });
});

describe("the verdict a card is sent back with names the real red", () => {
  const stopped: CheckRun = {
    name: "unit-ci", cmd: UNIT_CI_CHECK.cmd, ok: false, code: 97, ms: 1, timedOut: false, notMeasured: true,
    tail: "NOT MEASURED: the round stopped at the first red (e2e-ci), so this row was not waited for",
  };
  const red: CheckRun = { name: "e2e-ci", cmd: E2E_CI_CHECK.cmd, ok: false, code: 1, ms: 1, timedOut: false, tail: "e2e red on the pull request CI: e2e (5)" };

  test("the comment leads with the red row and its log, never with «not a red of the code»", () => {
    const text = formatChecksComment([stopped, red], { commit: "9bd99bd0" });
    expect(text).toStartWith("**Checks pre-review ROSSI**");
    expect(text).toContain("e2e red on the pull request CI: e2e (5)");
    expect(text).not.toContain("Non e' un rosso del codice");
    expect(formatChecksThreadSummary([stopped, red])).toContain("`e2e-ci`");
  });
});

describe("supersedeEarlierRounds", () => {
  const pr = (number: number, headRefName: string, card: string): OpenPullRequest => ({
    number, url: `https://github.com/o/r/pull/${number}`, headRefName, title: `board: ${headRefName} ${cardTag(card)}`,
  });

  test("a round on a new branch closes the card's pull requests on other branches, and nothing else", async () => {
    const closed: Array<{ n: number; comment: string }> = [];
    const cancelled: number[] = [];
    const { port } = fakePort({
      branch: async () => ({ ok: true, value: "topics/new" }),
      openPullRequests: async () => ({ ok: true, value: [pr(1, "topics/old", "12345678"), pr(2, "topics/new", "12345678"), pr(3, "topics/x", "99999999"), pr(4, "main", "12345678")] }),
      branchRuns: async (_repo, branch) => ({ ok: true, value: branch === "topics/old" ? [run({ id: 77, status: "in_progress", conclusion: null })] : [] }),
      closePullRequest: async (_cwd, _repo, n, comment) => { closed.push({ n, comment }); return { ok: true, value: "closed" }; },
      cancelRun: async (_repo, id) => { cancelled.push(id); return { ok: true, value: undefined }; },
    });
    const out = await supersedeEarlierRounds(port, { cwd: "/tmp", taskId: "12345678-card", baseBranch: "main" });
    expect(closed.map((c) => c.n)).toEqual([1]);
    expect(closed[0]!.comment).toContain("topics/new");
    expect(cancelled).toEqual([77]);
    expect(out.closed).toEqual([1]);
  });

  test("a checkout on main touches nothing", async () => {
    let listed = 0;
    const { port } = fakePort({
      branch: async () => ({ ok: true, value: "main" }),
      openPullRequests: async () => { listed += 1; return { ok: true, value: [pr(1, "topics/old", "12345678")] }; },
    });
    const out = await supersedeEarlierRounds(port, { cwd: "/tmp", taskId: "12345678-card", baseBranch: "main" });
    expect(out.closed).toEqual([]);
    expect(listed).toBe(0);
  });
});
