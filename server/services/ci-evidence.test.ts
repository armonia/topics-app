/**
 * The e2e verdict of a delivery comes from the pull request CI of the delivered
 * commit, and nothing but a green e2e run on that commit is a pass.
 *
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_CI_CHECK, UNIT_CI_CHECK } from "../../shared/board";
import {
  CI_BASE_BRANCH,
  CI_E2E_DEADLINE_MS,
  awaitCiEvidence,
  ciCheckRun,
  closeCiDraft,
  githubPort,
  listField,
  readE2eEvidence,
  readUnitEvidence,
  UNIT_STEP,
  repoFromRemote,
  pushRejectedAsNonFastForward,
  type AwaitCiDeps,
  type GithubJob,
  type GithubPort,
  type GithubRun,
  spawnCapped,
} from "./ci-evidence";
import { ChecksInterruptedError } from "./checks-gate";
import { CHECKS_LEG_MS } from "./checks-gate";
import { CHECKS_MAX_LEGS } from "../mcp/topics-mcp-server";
import { ASK_TTL_MS } from "../lib/ask-user-bridge";

const SHA = "a".repeat(40);
const run = (over: Partial<GithubRun> = {}): GithubRun => ({
  id: 10, head_sha: SHA, event: "pull_request", path: ".github/workflows/ci.yml",
  status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/10", ...over,
});
const job = (name: string, conclusion: string | null, over: Partial<GithubJob> = {}): GithubJob => ({
  id: name.length * 100 + (conclusion?.length ?? 0), name, status: conclusion ? "completed" : "in_progress", conclusion, ...over,
});
const green = [job("prepare-e2e", "success"), job("e2e (1)", "success"), job("e2e (2)", "success"), job("e2e (3)", "success"), job("e2e (4)", "success")];

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

const step = (name: string, conclusion: string | null) => ({ name, status: conclusion ? "completed" : "in_progress", conclusion });
const checkJob = (unit: string | null, over: Partial<GithubJob> = {}): GithubJob => ({
  id: 4242, name: "check", status: "in_progress", conclusion: null,
  steps: [step("Setup Bun", "success"), step("Typecheck (client + server ratchet + e2e)", "success"), step(UNIT_STEP, unit)],
  ...over,
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
    const job = checkJob("success", { status: "completed", conclusion: "failure" });
    job.steps![1] = step("Typecheck (client + server ratchet + e2e)", "failure");
    expect(readUnitEvidence(SHA, [run({ conclusion: "failure" })], [job]).kind).toBe("pass");
  });

  test("a skipped or cancelled unit step is not measured, never green", () => {
    for (const c of ["skipped", "cancelled"]) {
      const out = readUnitEvidence(SHA, [run({ conclusion: "failure" })], [checkJob(c, { status: "completed", conclusion: "failure" })]);
      expect(out.kind).toBe("notMeasured");
      if (out.kind === "notMeasured") expect(out.reason).toContain(c);
    }
  });

  test("a check job that failed before the step is not measured and says so", () => {
    const job: GithubJob = { id: 4242, name: "check", status: "completed", conclusion: "failure", steps: [step("Setup Bun", "failure")] };
    const out = readUnitEvidence(SHA, [run({ conclusion: "failure" })], [job]);
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

type Calls = {
  push: Array<{ sha: string; branch: string; lease?: string }>;
  runs: number; pr: number; merge: number;
  closed: number[]; deleted: string[];
};

function fakePort(over: Partial<GithubPort> = {}): { port: GithubPort; calls: Calls } {
  const calls: Calls = { push: [], runs: 0, pr: 0, merge: 0, closed: [], deleted: [] };
  const port: GithubPort = {
    ownCommits: async () => ({ ok: true, value: 2 }),
    branch: async () => ({ ok: true, value: "topics/card" }),
    repo: async () => ({ ok: true, value: "o/r" }),
    push: async (_cwd, sha, branch, lease) => { calls.push.push({ sha, branch, lease }); return { ok: true, value: "pushed" }; },
    remoteHead: async () => ({ ok: true, value: "c".repeat(40) }),
    inReflog: async () => ({ ok: true, value: false }),
    // The land case by default: the merge is on LOCAL main and nobody has
    // pushed it yet, so origin/main does not carry the branch.
    contains: async () => ({ ok: true, value: false }),
    openPullRequest: async () => ({ ok: true, value: null }),
    draftPullRequest: async () => { calls.pr += 1; return { ok: true, value: { number: 5, url: "https://github.com/o/r/pull/5" } }; },
    closePullRequest: async (_cwd, _repo, pr) => { calls.closed.push(pr); return { ok: true, value: "closed" }; },
    deleteRemoteBranch: async (_cwd, branch) => { calls.deleted.push(branch); return { ok: true, value: "deleted" }; },
    runs: async () => { calls.runs += 1; return { ok: true, value: [run()] }; },
    jobs: async () => ({ ok: true, value: green }),
    mergeState: async () => { calls.merge += 1; return { ok: true, value: "MERGEABLE" }; },
    ...over,
  };
  // Keep the counters when a test overrides a counted method.
  if (over.runs) { const inner = over.runs; port.runs = async (...a) => { calls.runs += 1; return inner(...a); }; }
  if (over.push) { const inner = over.push; port.push = async (...a) => { calls.push.push({ sha: a[1], branch: a[2], lease: a[3] }); return inner(...a); }; }
  if (over.mergeState) { const inner = over.mergeState; port.mergeState = async (...a) => { calls.merge += 1; return inner(...a); }; }
  if (over.closePullRequest) { const inner = over.closePullRequest; port.closePullRequest = async (...a) => { calls.closed.push(a[2]); return inner(...a); }; }
  if (over.deleteRemoteBranch) { const inner = over.deleteRemoteBranch; port.deleteRemoteBranch = async (...a) => { calls.deleted.push(a[1]); return inner(...a); }; }
  return { port, calls };
}

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

const input = { cwd: "/tmp/wt", sha: SHA, taskId: "12345678-card" };
const e2eRow = async (i: typeof input, d: AwaitCiDeps) => (await awaitCiEvidence({ ...i, checks: [E2E_CI_CHECK] }, d))[0]!;

describe("spawnCapped", () => {
  // `git push` runs its hook and ssh as children: a cap that killed git alone
  // waited for them to close the pipe (96 s with a 95 s hook), forever with ssh.
  test("the cap kills the child's whole group and answers without waiting for its pipes", async () => {
    const started = performance.now();
    const r = await spawnCapped(["sh", "-c", "sleep 30 & echo $!; wait"], tmpdir(), 500);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(r.code).toBe(137);
    const grandchild = Number(r.out.trim());
    expect(grandchild).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(grandchild, 0); await Bun.sleep(50); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  test("a call that exits while a child it left still holds the pipe answers with its own code", async () => {
    const started = performance.now();
    const r = await spawnCapped(["sh", "-c", "echo ok; sleep 20 & exit 0"], tmpdir(), 15_000);
    expect(performance.now() - started).toBeLessThan(6_000);
    expect(r.code).toBe(0);
    expect(r.out).toBe("ok\n");
  });

  test("a call that ends on its own keeps its exit code and output", async () => {
    const r = await spawnCapped(["sh", "-c", "echo out; echo err >&2; exit 3"], tmpdir(), 10_000);
    expect(r).toEqual({ code: 3, out: "out\n", err: "err\n" });
  });
});

describe("awaitCiEvidence with the e2e row", () => {
  test("a gh auth error on the pull request is NOT MEASURED at once, without polling", async () => {
    const { port, calls } = fakePort({ draftPullRequest: async () => ({ ok: false, error: "gh: not logged in" }) });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.code).toBe(97);
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("not logged in");
    expect(calls.runs).toBe(0);
  });

  test("a rejected push with a remote head outside the reflog never forces", async () => {
    const { port, calls } = fakePort({ push: async () => ({ ok: true, value: "non-fast-forward" }) });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.notMeasured).toBe(true);
    expect(calls.push.length).toBe(1);
    expect(calls.push[0]!.lease).toBeUndefined();
    expect(calls.pr).toBe(0);
  });

  test("a rejected push with a remote head from the reflog forces with that head as lease", async () => {
    const remote = "c".repeat(40);
    const { port, calls } = fakePort({
      push: async (_c, _s, _b, lease) => ({ ok: true, value: lease ? "pushed" : "non-fast-forward" }),
      inReflog: async (_c, _b, sha) => ({ ok: true, value: sha === remote }),
    });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(calls.push.map((p) => p.lease)).toEqual([undefined, remote]);
    expect(row.ok).toBe(true);
    expect(calls.runs).toBe(1);
  });

  test("a run that never finishes is NOT MEASURED at the deadline, never green", async () => {
    const clock = fakeClock();
    const pushedAt = clock.now();
    const { port } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      jobs: async () => ({ ok: true, value: [job("prepare-e2e", "success"), job("e2e (1)", null)] }),
    });
    const row = await e2eRow(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(row.ok).toBe(false);
    expect(row.notMeasured).toBe(true);
    expect(clock.now() - pushedAt).toBeGreaterThanOrEqual(CI_E2E_DEADLINE_MS);
    expect(clock.now() - pushedAt).toBeLessThan(CI_E2E_DEADLINE_MS + 2 * 60_000);
    expect(row.tail).toContain("actions/runs/10");
  });

  test("no run after the grace and a conflicting pull request end the wait before the deadline", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [] }),
      mergeState: async () => ({ ok: true, value: "CONFLICTING" }),
    });
    const row = await e2eRow(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("conflicts");
    expect(calls.merge).toBe(1);
    expect(clock.now() - start).toBeLessThan(10 * 60_000);
  });

  test("three failed reads then green is a pass; five in a row is NOT MEASURED", async () => {
    let n = 0;
    const flaky = fakePort({ runs: async () => (++n <= 3 ? { ok: false, error: "HTTP 502" } : { ok: true, value: [run()] }) });
    const pass = await e2eRow(input, { port: flaky.port, ...fakeClock(), stopping: () => false });
    expect(pass.ok).toBe(true);
    const down = fakePort({ runs: async () => ({ ok: false, error: "HTTP 502" }) });
    const nm = await e2eRow(input, { port: down.port, ...fakeClock(), stopping: () => false });
    expect(nm.notMeasured).toBe(true);
    expect(down.calls.runs).toBe(5);
  });

  test("a shutdown during the sleep rejects with ChecksInterruptedError", async () => {
    const clock = fakeClock();
    let stop = false;
    const { port } = fakePort({ runs: async () => ({ ok: true, value: [] }) });
    const sleep = async (ms: number) => { clock.advance(ms); stop = true; };
    await expect(e2eRow(input, { port, now: clock.now, sleep, stopping: () => stop })).rejects.toBeInstanceOf(ChecksInterruptedError);
  });

  test("no commit beyond main is green with a note, and nothing is pushed or opened", async () => {
    const { port, calls } = fakePort({ ownCommits: async () => ({ ok: true, value: 0 }) });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.ok).toBe(true);
    expect(row.tail).toContain("no commit of its own");
    expect(calls.push.length).toBe(0);
    expect(calls.pr).toBe(0);
  });

  test("the push carries the measured commit, not HEAD", async () => {
    const { port, calls } = fakePort();
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.ok).toBe(true);
    expect(calls.push).toEqual([{ sha: SHA, branch: "topics/card", lease: undefined }]);
    expect(row.tail).toContain("pull/5");
  });
});

describe("awaitCiEvidence with the e2e and the unit rows", () => {
  const both = { ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] };

  test("one push, one draft and one poll loop give both verdicts, in the declared order", async () => {
    let polls = 0;
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      // The unit step finishes at the second poll, the e2e shards at the fourth.
      jobs: async () => {
        polls += 1;
        const e2e = polls >= 4 ? green : green.map((j) => (j.name === "e2e (4)" ? job("e2e (4)", null) : j));
        return { ok: true, value: [checkJob(polls >= 2 ? "success" : null), ...e2e] };
      },
    });
    const rows = await awaitCiEvidence(both, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => [r.cmd, r.ok])).toEqual([[E2E_CI_CHECK.cmd, true], [UNIT_CI_CHECK.cmd, true]]);
    expect(calls.push.length).toBe(1);
    expect(calls.pr).toBe(1);
    expect(calls.runs).toBe(4);
    // The unit verdict was settled when its step finished, not when the e2e did.
    expect(rows[1]!.ms).toBeLessThan(rows[0]!.ms);
  });

  test("a red unit step next to green e2e is a red unit row and a green e2e row", async () => {
    const { port } = fakePort({ jobs: async () => ({ ok: true, value: [checkJob("failure", { status: "completed", conclusion: "failure" }), ...green] }) });
    const rows = await awaitCiEvidence(both, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => r.ok)).toEqual([true, false]);
    expect(rows[1]!.tail).toContain("--log-failed");
  });

  test("green e2e and a unit step that never finishes: the unit row is NOT MEASURED at the deadline, the e2e row stays green", async () => {
    const { port } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      jobs: async () => ({ ok: true, value: [checkJob(null), ...green] }),
    });
    const rows = await awaitCiEvidence(both, { port, ...fakeClock(), stopping: () => false });
    expect(rows[0]!.ok).toBe(true);
    expect(rows[1]!.notMeasured).toBe(true);
    expect(rows[1]!.tail).toContain("no CI verdict");
  });

  test("a failed push is NOT MEASURED for both rows", async () => {
    const { port } = fakePort({ push: async () => ({ ok: false, error: "denied" }) });
    const rows = await awaitCiEvidence(both, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => r.notMeasured)).toEqual([true, true]);
  });
});

describe("GitHub answers without the expected list", () => {
  test("a body with no array is an error, not an undefined list that throws later", () => {
    expect(listField<GithubRun>('{"workflow_runs":[{"id":1}]}', "workflow_runs")).toEqual([{ id: 1 } as GithubRun]);
    expect(() => listField('{"total_count":0}', "workflow_runs")).toThrow("no \"workflow_runs\" array");
    expect(() => listField('{"jobs":{"id":1}}', "jobs")).toThrow();
    expect(() => listField("null", "jobs")).toThrow();
  });

  test("runs() through a gh that exits 0 with {\"total_count\":0} is a failed read, and the wait ends NOT MEASURED", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ci-evidence-gh-"));
    const oldPath = process.env.PATH;
    try {
      writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '{\"total_count\":0}'\n");
      chmodSync(join(bin, "gh"), 0o755);
      process.env.PATH = `${bin}:${oldPath}`;
      const got = await githubPort().runs("o/r", SHA);
      expect(got.ok).toBe(false);
      const { port } = fakePort({ runs: githubPort().runs });
      const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
      expect(row.notMeasured).toBe(true);
      expect(row.tail).toContain("GitHub reads failed");
    } finally {
      process.env.PATH = oldPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("the delivery push goes through the repo's push guard, from a worktree too", () => {
  const TERM = "Zzyzx Quiverleaf"; // invented, like the push guard's own test

  test("an intermediate commit with a removed name is NOT MEASURED and never reaches the remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-evidence-push-guard-"));
    const main = join(root, "main");
    const wt = join(root, "wt");
    const bare = join(root, "origin.git");
    const hooks = join(root, "hooks");
    const env: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    delete env.TOPICS_PERSONAL_TERMS;
    const git = (cwd: string, ...args: string[]): string => {
      const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    const savedTerms = process.env.TOPICS_PERSONAL_TERMS;
    delete process.env.TOPICS_PERSONAL_TERMS;
    // The test preload points core.hooksPath at nothing through GIT_CONFIG_*,
    // which beats the repo config: for this push the hooks are the point.
    const hookKey = Object.keys(process.env).find((k) => k.startsWith("GIT_CONFIG_KEY_") && process.env[k] === "core.hooksPath");
    const hookValueKey = hookKey?.replace("KEY", "VALUE");
    const savedHooks = hookValueKey ? process.env[hookValueKey] : undefined;
    try {
      mkdirSync(main);
      mkdirSync(hooks);
      git(root, "init", "-q", "--bare", bare);
      git(main, "init", "-q", "-b", "main");
      // The repo's own hook and guard, at the paths the hook looks them up.
      copyFileSync(join(import.meta.dir, "../../scripts/git-hooks/pre-push"), join(hooks, "pre-push"));
      chmodSync(join(hooks, "pre-push"), 0o755);
      mkdirSync(join(main, "scripts"));
      for (const f of ["check-push-clean.ts", "personal-terms.ts"]) copyFileSync(join(import.meta.dir, "../../scripts", f), join(main, "scripts", f));
      writeFileSync(join(main, ".gitignore"), ".personal-terms\n");
      git(main, "add", "-A");
      git(main, "commit", "-q", "-m", "base");
      git(main, "remote", "add", "origin", bare);
      git(main, "push", "-q", "--no-verify", "origin", "main");
      git(main, "config", "core.hooksPath", hooks);
      if (hookValueKey) process.env[hookValueKey] = hooks;
      writeFileSync(join(main, ".personal-terms"), `${TERM}\n`);
      git(main, "worktree", "add", "-q", "-b", "topics/card", wt);
      writeFileSync(join(wt, "note.txt"), `asked by ${TERM}\n`);
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "wip");
      writeFileSync(join(wt, "note.txt"), "asked by the reviewer\n");
      git(wt, "commit", "-q", "-am", "the name goes away");
      const sha = git(wt, "rev-parse", "HEAD");

      const { port, calls } = fakePort({ push: githubPort().push });
      const row = await e2eRow({ cwd: wt, sha, taskId: "12345678-card" }, { port, ...fakeClock(), stopping: () => false });
      expect(row.notMeasured).toBe(true);
      expect(row.tail).toContain("push failed");
      expect(calls.pr).toBe(0);
      expect(git(main, "ls-remote", "origin", "refs/heads/topics/card")).toBe("");
    } finally {
      if (savedTerms !== undefined) process.env.TOPICS_PERSONAL_TERMS = savedTerms;
      if (hookValueKey && savedHooks !== undefined) process.env[hookValueKey] = savedHooks;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
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

/**
 * Nothing ever closed a draft: no `gh pr close` and no `push --delete` existed
 * in the tree, while origin carried 41 `topics/*` branches with 39 of them
 * already inside `main`.
 */
describe("closeCiDraft", () => {
  test("closes the draft found by the same lookup that opens it, then deletes the branch", async () => {
    const seen: string[] = [];
    const { port, calls } = fakePort({
      openPullRequest: async (_cwd, _repo, branch) => {
        seen.push(branch);
        return { ok: true, value: { number: 78, url: "https://github.com/o/r/pull/78" } };
      },
    });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/delivered", reason: "landed", closePr: true }, { port });
    expect(seen).toEqual(["topics/delivered"]);
    expect(out.pr?.number).toBe(78);
    expect(out.branchDeleted).toBe(true);
    expect(out.problems).toEqual([]);
    expect(calls.closed).toEqual([78]);
    expect(calls.deleted).toEqual(["topics/delivered"]);
  });

  /**
   * THE ORDER IS THE CONTRACT, and until this test nothing measured it: with the
   * two halves swapped the whole suite stayed green (45 pass / 0 fail).
   *
   * The port below models the one GitHub behaviour that makes the order matter -
   * deleting a head branch closes its pull request - and `openPullRequest` asks
   * for `--state open`, exactly as the real one does. Delete first and the close
   * finds nothing: the `reason`, the only line that says on GitHub why this
   * branch ended, is never posted and the receipt loses the number.
   */
  test("the pull request is closed BEFORE the branch is deleted, or GitHub closes it first and the reason is never posted", async () => {
    let prState: "open" | "closed" = "open";
    const said: string[] = [];
    const { port } = fakePort({
      openPullRequest: async () => ({ ok: true, value: prState === "open" ? { number: 78, url: "u" } : null }),
      closePullRequest: async (_cwd, _repo, _pr, comment) => {
        if (prState === "closed") return { ok: false, error: "gh: pull request is already closed" };
        prState = "closed";
        said.push(comment);
        return { ok: true, value: "closed" as const };
      },
      deleteRemoteBranch: async () => { prState = "closed"; return { ok: true, value: "deleted" as const }; },
    });
    const out = await closeCiDraft(
      { cwd: "/tmp/wt", branch: "topics/delivered", reason: "Closed by the Topics board: superseded.", closePr: true },
      { port },
    );
    expect(out.pr?.number).toBe(78);
    expect(said).toEqual(["Closed by the Topics board: superseded."]);
    expect(out.branchDeleted).toBe(true);
  });

  /**
   * THE REGRESSION THIS FLAG EXISTS FOR. `confirmLandedOnMain` re-reads the LOCAL
   * main and no code path in this server pushes main, so when the land's sweep
   * runs `origin/main` does not carry the merge yet. GitHub marks that pull
   * request MERGED itself once a person pushes - observed on #78, 17/09/2026, a
   * minute after the land - and a `gh pr close` racing that push would stamp
   * "Closed" on the ~32 cards that land in a week.
   */
  test("closePr false never touches the pull request", async () => {
    const { port, calls } = fakePort({
      openPullRequest: async () => ({ ok: true, value: { number: 78, url: "u" } }),
      contains: async () => ({ ok: true, value: true }),
    });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/landed", reason: "landed", closePr: false }, { port });
    expect(calls.closed).toEqual([]);
    expect(out.pr).toBeNull();
    expect(out.branchDeleted).toBe(true);
    expect(calls.deleted).toEqual(["topics/landed"]);
    expect(out.problems).toEqual([]);
  });

  /**
   * DELETING THE HEAD BRANCH IS ITSELF A WAY OF CLOSING THE PULL REQUEST, and
   * GitHub closes it as CLOSED, never as merged. On this repo #27 and #28 - never
   * merged - read `closed` and `head_ref_deleted` at the SAME second inside a
   * burst of ten deletions, while #78, which really landed, has `merged` 33
   * seconds BEFORE its branch went. The land door can only produce the first
   * order: `confirmLandedOnMain` re-reads the LOCAL main and nothing in this
   * server pushes main, so the delete always precedes the human push. So a flag
   * that only stops `gh pr close` moved who did the closing, not whether it
   * happened - and it lost the `reason` comment on the way.
   */
  test("closePr false keeps the branch too until origin/main carries it", async () => {
    const { port, calls } = fakePort({
      openPullRequest: async () => ({ ok: true, value: { number: 78, url: "u" } }),
      contains: async () => ({ ok: true, value: false }),
    });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/landed", reason: "landed", closePr: false }, { port });
    expect(calls.deleted).toEqual([]);
    expect(calls.closed).toEqual([]);
    expect(out.branchDeleted).toBe(false);
    expect(out.problems.join(" ")).toContain("does not carry it yet");
  });

  // The half nobody can undo: a read that does not conclude must not be read as
  // «origin/main carries it».
  test("a read that does not conclude keeps the branch", async () => {
    for (const over of [
      { remoteHead: async () => ({ ok: false as const, error: "ls-remote exited 128" }) },
      { contains: async () => ({ ok: false as const, error: "merge-base: not a valid object name" }) },
      { remoteHead: async (_c: string, b: string) => ({ ok: true as const, value: b === CI_BASE_BRANCH ? null : "a".repeat(40) }) },
    ]) {
      const { port, calls } = fakePort(over);
      const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/landed", reason: "landed", closePr: false }, { port });
      expect(calls.deleted).toEqual([]);
      expect(out.branchDeleted).toBe(false);
      expect(out.problems).toHaveLength(1);
    }
  });

  // Nothing on origin means there is no head branch whose deletion could close
  // anything: the guard must not stand between the caller and an `absent`.
  test("a branch already gone from origin is not held back by the guard", async () => {
    const { port, calls } = fakePort({
      remoteHead: async () => ({ ok: true, value: null }),
      deleteRemoteBranch: async () => ({ ok: true, value: "absent" as const }),
    });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/landed", reason: "landed", closePr: false }, { port });
    expect(calls.deleted).toEqual(["topics/landed"]);
    expect(out.problems).toEqual([]);
  });

  test("no open pull request is not a problem: the branch still goes", async () => {
    const { port, calls } = fakePort();
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/delivered", reason: "archived", closePr: true }, { port });
    expect(out.pr).toBeNull();
    expect(out.branchDeleted).toBe(true);
    expect(calls.closed).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  // `select count(*) from tasks where delivery_branch='main'` is 0 on the live DB:
  // this is a floor on an argument the function does not control - it arrives from
  // the land result, the card's `delivery_branch` or an attempt row - not a fix
  // for a row anyone has seen. Deleting `main` on origin is the one move here the
  // Mac cannot undo, and the check is two string comparisons.
  test("main is refused, and so is the branch the checkout is sitting on", async () => {
    const { port, calls } = fakePort({ branch: async () => ({ ok: true, value: "topics/live" }) });
    const onMain = await closeCiDraft({ cwd: "/tmp/wt", branch: "main", reason: "landed", closePr: true }, { port });
    expect(onMain.branchDeleted).toBe(false);
    expect(onMain.problems[0]).toContain("integration branch");
    const onLive = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/live", reason: "landed", closePr: true }, { port });
    expect(onLive.branchDeleted).toBe(false);
    expect(onLive.problems[0]).toContain("is itself on topics/live");
    expect(calls.deleted).toEqual([]);
    expect(calls.closed).toEqual([]);
  });

  test("a remote branch that is already gone is not a failure", async () => {
    const { port } = fakePort({ deleteRemoteBranch: async () => ({ ok: true, value: "absent" }) });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/delivered", reason: "landed", closePr: true }, { port });
    expect(out.branchDeleted).toBe(false);
    expect(out.problems).toEqual([]);
  });

  // Housekeeping, not a gate: a gh that is logged out must never throw into a land.
  test("a gh failure is collected, never thrown, and does not stop the other half", async () => {
    const { port, calls } = fakePort({
      openPullRequest: async () => ({ ok: true, value: { number: 9, url: "u" } }),
      closePullRequest: async () => ({ ok: false, error: "gh: not logged in" }),
    });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/delivered", reason: "landed", closePr: true }, { port });
    expect(out.pr).toBeNull();
    expect(out.problems.join(" ")).toContain("not logged in");
    expect(out.branchDeleted).toBe(true);
    expect(calls.deleted).toEqual(["topics/delivered"]);
  });

  /**
   * `push --delete` is git against origin: it has nothing to do with `gh`, and a
   * project of this board whose `origin` is not GitHub would otherwise lose the
   * branch half too, because `port.repo` cannot name a repo for it.
   */
  test("an origin that is not GitHub still loses its branch: only the pull-request half is skipped", async () => {
    const { port, calls } = fakePort({
      repo: async () => ({ ok: false, error: "no GitHub repo for this remote" }),
    });
    const out = await closeCiDraft({ cwd: "/tmp/wt", branch: "topics/delivered", reason: "archived", closePr: true }, { port });
    expect(out.branchDeleted).toBe(true);
    expect(calls.deleted).toEqual(["topics/delivered"]);
    expect(out.pr).toBeNull();
    expect(out.problems.join(" ")).toContain("no GitHub repo");
  });

  test("the real port deletes a remote branch, and reads an already-absent one as absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-evidence-delete-"));
    const wt = join(root, "wt");
    const bare = join(root, "origin.git");
    const env: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (cwd: string, ...args: string[]): string => {
      const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    try {
      mkdirSync(wt);
      git(root, "init", "-q", "--bare", bare);
      git(wt, "init", "-q", "-b", "main");
      git(wt, "remote", "add", "origin", bare);
      writeFileSync(join(wt, "a.txt"), "a\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "one");
      git(wt, "push", "-q", "--no-verify", "origin", "HEAD:refs/heads/topics/delivered");
      expect(git(wt, "ls-remote", "origin", "refs/heads/topics/delivered")).toContain("topics/delivered");
      const port = githubPort();
      expect(await port.deleteRemoteBranch(wt, "topics/delivered")).toEqual({ ok: true, value: "deleted" });
      expect(git(wt, "ls-remote", "origin", "refs/heads/topics/delivered")).toBe("");
      expect(await port.deleteRemoteBranch(wt, "topics/delivered")).toEqual({ ok: true, value: "absent" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * THE SAME QUESTION ASKED OF GIT INSTEAD OF A STUB, because the stub cannot
   * fail the way the land does: it is `git push origin --delete` against a real
   * origin, and origin's main is a real ref that the Mac's local main is ahead
   * of. `gh` never enters - `closePr` is false and the pull-request half is
   * skipped - so this runs anywhere.
   *
   * The two states are the land's timeline, minute by minute: the merge is on
   * local main and origin/main still points at the old commit (the branch must
   * survive), then a person pushes main (the branch may go).
   */
  test("on real git the landed branch survives until origin/main carries it, and goes right after", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-evidence-landed-"));
    const wt = join(root, "wt");
    const bare = join(root, "origin.git");
    const env: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (cwd: string, ...args: string[]): string => {
      const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    const onOrigin = (branch: string): boolean => git(wt, "ls-remote", "origin", `refs/heads/${branch}`) !== "";
    try {
      mkdirSync(wt);
      git(root, "init", "-q", "--bare", bare);
      git(wt, "init", "-q", "-b", CI_BASE_BRANCH);
      git(wt, "remote", "add", "origin", bare);
      writeFileSync(join(wt, "a.txt"), "a\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "base");
      git(wt, "push", "-q", "--no-verify", "origin", CI_BASE_BRANCH);
      // The delivery: its own branch, pushed, as every card's does.
      git(wt, "checkout", "-q", "-b", "topics/landed");
      writeFileSync(join(wt, "b.txt"), "b\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "work");
      git(wt, "push", "-q", "--no-verify", "origin", "topics/landed");
      // The land: merged into LOCAL main, and nothing in this server pushes main.
      git(wt, "checkout", "-q", CI_BASE_BRANCH);
      git(wt, "merge", "-q", "--no-ff", "-m", "land", "topics/landed");
      // The checkout must not be sitting on the branch, or the earlier floor answers first.
      expect(git(wt, "symbolic-ref", "--quiet", "--short", "HEAD")).toBe(CI_BASE_BRANCH);

      const first = await closeCiDraft({ cwd: wt, branch: "topics/landed", reason: "landed", closePr: false });
      expect(first.branchDeleted).toBe(false);
      expect(first.problems.join(" ")).toContain("does not carry it yet");
      expect(onOrigin("topics/landed")).toBe(true);

      // A person pushes main - measured on #78 as a minute after the land.
      git(wt, "push", "-q", "--no-verify", "origin", CI_BASE_BRANCH);
      const second = await closeCiDraft({ cwd: wt, branch: "topics/landed", reason: "landed", closePr: false });
      expect(second.problems).toEqual([]);
      expect(second.branchDeleted).toBe(true);
      expect(onOrigin("topics/landed")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
