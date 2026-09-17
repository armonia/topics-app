/**
 * The readers: what a single answer from GitHub (`runs` + `jobs`) says about the
 * e2e side and about the unit step, and the contracts that keep those names
 * pinned to `ci.yml`. The wait loop around them is
 * `ci-evidence-wait.test.ts`, its verdict `ci-evidence-verdict.test.ts`.
 *
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_CI_CHECK, UNIT_CI_CHECK } from "../../shared/board";
import {
  CI_E2E_DEADLINE_MS,
  ciCheckRun,
  readE2eEvidence,
  readUnitEvidence,
  UNIT_STEP,
  repoFromRemote,
  pushRejectedAsNonFastForward,
  type GithubJob,
} from "./ci-evidence";
import { CHECKS_LEG_MS } from "./checks-gate";
import { CHECKS_MAX_LEGS } from "../mcp/topics-mcp-server";
import { ASK_TTL_MS } from "../lib/ask-user-bridge";
import { SHA, checkJob, green, job, run, step } from "./ci-evidence.testkit";

describe("readE2eEvidence", () => {
  test("a green run of another commit, and none of ours, is pending", () => {
    expect(readE2eEvidence(SHA, [run({ head_sha: "b".repeat(40) })], green).kind).toBe("pending");
  });

  test("a green push run of our commit is pending", () => {
    expect(readE2eEvidence(SHA, [run({ event: "push" })], green).kind).toBe("pending");
  });

  test("the newest run counts: an older green and a newer cancelled run are not measured", () => {
    const out = readE2eEvidence(SHA, [run({ id: 12, conclusion: "cancelled" }), run({ id: 11 })], green);
    expect(out.kind).toBe("notMeasured");
    const reversed = readE2eEvidence(SHA, [run({ id: 11 }), run({ id: 12, conclusion: "cancelled" })], green);
    expect(reversed.kind).toBe("notMeasured");
  });

  test("one red shard is a fail, and the row names it with its log command", () => {
    const jobs = green.map((j) => (j.name === "e2e (2)" ? { ...j, id: 777, conclusion: "failure" } : j));
    const out = readE2eEvidence(SHA, [run({ conclusion: "failure" })], jobs);
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") return;
    const row = ciCheckRun(E2E_CI_CHECK, out, 1, { repo: "o/r", prUrl: "https://github.com/o/r/pull/5" });
    expect(row.ok).toBe(false);
    expect(row.code).toBe(1);
    expect(row.notMeasured).toBeUndefined();
    expect(row.tail).toContain("e2e (2)");
    expect(row.tail).toContain("gh run view --job 777 --log-failed -R o/r");
  });

  test("three green shards and one still running is pending", () => {
    const jobs = green.map((j) => (j.name === "e2e (4)" ? job("e2e (4)", null) : j));
    expect(readE2eEvidence(SHA, [run({ status: "in_progress", conclusion: null })], jobs).kind).toBe("pending");
  });

  test("prepare-e2e red with skipped shards is not measured and names prepare-e2e", () => {
    const jobs = [job("prepare-e2e", "failure"), ...[1, 2, 3, 4].map((n) => job(`e2e (${n})`, "skipped"))];
    const out = readE2eEvidence(SHA, [run({ conclusion: "failure" })], jobs);
    expect(out.kind).toBe("notMeasured");
    if (out.kind === "notMeasured") expect(out.reason).toContain("prepare-e2e");
  });

  test("a finished run with no e2e job is not measured", () => {
    expect(readE2eEvidence(SHA, [run()], [job("check", "success")]).kind).toBe("notMeasured");
  });

  test("a timed-out or cancelled shard with the others green is neither pass nor fail", () => {
    for (const c of ["timed_out", "cancelled"]) {
      const jobs = green.map((j) => (j.name === "e2e (3)" ? { ...j, conclusion: c } : j));
      expect(readE2eEvidence(SHA, [run()], jobs).kind).toBe("notMeasured");
    }
  });

  test("an unexpanded e2e job, cancelled, is not measured", () => {
    const out = readE2eEvidence(SHA, [run({ conclusion: "failure" })], [job("prepare-e2e", "success"), job("e2e", "cancelled")]);
    expect(out.kind).toBe("notMeasured");
  });

  test("remote and porcelain parsing", () => {
    expect(repoFromRemote("git@github.com:armonia/topics-app.git")).toBe("armonia/topics-app");
    expect(repoFromRemote("https://github.com/armonia/topics-app")).toBe("armonia/topics-app");
    expect(repoFromRemote("git@gitlab.com:a/b.git")).toBeNull();
    expect(pushRejectedAsNonFastForward("!\trefs/x:refs/heads/b\t[rejected] (non-fast-forward)")).toBe(true);
    expect(pushRejectedAsNonFastForward("=\trefs/x:refs/heads/b\t[up to date]")).toBe(false);
  });
});

describe("readUnitEvidence", () => {
  test("the unit step green on our commit is a pass, even while the rest of the check job runs", () => {
    const out = readUnitEvidence(SHA, [run({ status: "in_progress", conclusion: null })], [checkJob("success"), ...green]);
    expect(out.kind).toBe("pass");
    if (out.kind !== "pass") return;
    const row = ciCheckRun(UNIT_CI_CHECK, out, 1, { repo: "o/r", prUrl: "https://github.com/o/r/pull/5" });
    expect(row.ok).toBe(true);
    expect(row.tail).toContain("unit tests green on the pull request CI");
    expect(row.tail).toContain("pull/5");
  });

  test("a green unit step of another commit, or of a push run, is pending", () => {
    expect(readUnitEvidence(SHA, [run({ head_sha: "b".repeat(40) })], [checkJob("success")]).kind).toBe("pending");
    expect(readUnitEvidence(SHA, [run({ event: "push" })], [checkJob("success")]).kind).toBe("pending");
  });

  test("the unit step red is a fail with the log command of the check job", () => {
    const out = readUnitEvidence(SHA, [run({ conclusion: "failure" })], [checkJob("failure", { status: "completed", conclusion: "failure" })]);
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") return;
    const row = ciCheckRun(UNIT_CI_CHECK, out, 1, { repo: "o/r" });
    expect(row.ok).toBe(false);
    expect(row.code).toBe(1);
    expect(row.tail).toContain("unit tests red on the pull request CI");
    expect(row.tail).toContain("gh run view --job 4242 --log-failed -R o/r");
  });

  test("a red typecheck step with the unit step green is still a unit pass: the row reads only its step", () => {
    const one = checkJob("success", { status: "completed", conclusion: "failure" });
    one.steps![1] = step("Typecheck (client + server ratchet + e2e)", "failure");
    expect(readUnitEvidence(SHA, [run({ conclusion: "failure" })], [one]).kind).toBe("pass");
  });

  test("a skipped or cancelled unit step is not measured, never green", () => {
    for (const c of ["skipped", "cancelled"]) {
      const out = readUnitEvidence(SHA, [run({ conclusion: "failure" })], [checkJob(c, { status: "completed", conclusion: "failure" })]);
      expect(out.kind).toBe("notMeasured");
      if (out.kind === "notMeasured") expect(out.reason).toContain(c);
    }
  });

  test("a check job that failed before the step is not measured and says so", () => {
    const died: GithubJob = { id: 4242, name: "check", status: "completed", conclusion: "failure", steps: [step("Setup Bun", "failure")] };
    const out = readUnitEvidence(SHA, [run({ conclusion: "failure" })], [died]);
    expect(out.kind).toBe("notMeasured");
    if (out.kind === "notMeasured") expect(out.reason).toContain("without running the step");
    const cut = readUnitEvidence(SHA, [run({ conclusion: "failure" })], [checkJob(null, { status: "completed", conclusion: "cancelled" })]);
    expect(cut.kind).toBe("notMeasured");
  });

  test("a step still running is pending; a finished run without the check job is not measured", () => {
    expect(readUnitEvidence(SHA, [run({ status: "in_progress", conclusion: null })], [checkJob(null)]).kind).toBe("pending");
    expect(readUnitEvidence(SHA, [run({ status: "in_progress", conclusion: null })], green).kind).toBe("pending");
    expect(readUnitEvidence(SHA, [run()], green).kind).toBe("notMeasured");
    expect(readUnitEvidence(SHA, [run({ id: 12, conclusion: "cancelled" }), run({ id: 11 })], [checkJob("success")]).kind).toBe("notMeasured");
  });
});

describe("contracts", () => {
  test("ci.yml still has the jobs and the tier this reader relies on", () => {
    const ci = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/^on:\n(?:.*\n)*?\s{2}pull_request:/m);
    expect(ci).toMatch(/^ {2}prepare-e2e:$/m);
    const e2e = ci.slice(ci.search(/^ {2}e2e:$/m));
    expect(ci.search(/^ {2}e2e:$/m)).toBeGreaterThan(0);
    expect(e2e).toMatch(/^ {4}needs: prepare-e2e$/m);
    expect(e2e).toContain("E2E_TIER: pr");
    expect(e2e).toContain("if: ${{ matrix.shard == 1 && github.event_name == 'pull_request' }}");
    expect(e2e).toContain("bun run check:e2e-touched --base=\"origin/${{ github.base_ref }}\"");
  });

  // THE SHAPE OF THE NAMES, not only the name of the step (its twin, below).
  // `E2E_JOB` reads `e2e (N)`: GitHub spells a one-axis matrix that way and a
  // two-axis one `e2e (1, chromium)`, which matches nothing — every delivery
  // would come back NOT MEASURED with the CI green, and no gate would notice.
  // Not theoretical: the install step of this very job already pulls "Chromium
  // + WebKit", so a second axis is one line away.
  test("the e2e matrix still has ONE axis, or the job names this reader matches change", () => {
    const ci = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
    const from = ci.search(/^ {2}e2e:$/m);
    const rest = ci.slice(from + 1);
    const next = rest.search(/^ {2}[\w-]+:$/m);
    const e2e = next >= 0 ? rest.slice(0, next) : rest;
    const matrix = e2e.match(/^ {6}matrix:\n((?: {8}\S.*\n| {10}.*\n|\n)+)/m);
    expect(matrix).not.toBeNull();
    const axes = matrix![1]!.split("\n").filter((l) => /^ {8}\S/.test(l)).map((l) => l.trim().split(":")[0]);
    expect(axes).toEqual(["shard"]);
    // And the names that axis produces are the ones `E2E_JOB` accepts.
    expect(e2e).toMatch(/^ {8}shard: \[(\d+(, )?)+\]$/m);
  });

  test("ci.yml still runs the unit suite in the step the unit row reads, inside the check job", () => {
    const ci = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
    const check = ci.slice(ci.search(/^ {2}check:$/m), ci.search(/^ {2}prepare-e2e:$/m));
    expect(ci.search(/^ {2}check:$/m)).toBeGreaterThan(0);
    expect(check).toMatch(new RegExp(`- name: ${UNIT_STEP.replace(/[+]/g, "\\+")}\\n(?: .*\\n)*? +run: bun test:unit\\n`));
  });

  test("the client waits past the CI deadline plus the slowest local round, and below the CLI tool timeout", () => {
    const legsMs = CHECKS_MAX_LEGS * CHECKS_LEG_MS;
    expect(CI_E2E_DEADLINE_MS + 30 * 60_000).toBeLessThanOrEqual(legsMs);
    expect(legsMs).toBeLessThan(ASK_TTL_MS + 5 * 60_000);
  });
});
