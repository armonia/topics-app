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
import { E2E_CI_CHECK } from "../../shared/board";
import {
  CI_E2E_DEADLINE_MS,
  awaitE2eEvidence,
  ciCheckRun,
  githubPort,
  listField,
  readE2eEvidence,
  repoFromRemote,
  pushRejectedAsNonFastForward,
  type GithubJob,
  type GithubPort,
  type GithubRun,
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

type Calls = { push: Array<{ sha: string; branch: string; lease?: string }>; runs: number; pr: number; merge: number };

function fakePort(over: Partial<GithubPort> = {}): { port: GithubPort; calls: Calls } {
  const calls: Calls = { push: [], runs: 0, pr: 0, merge: 0 };
  const port: GithubPort = {
    ownCommits: async () => ({ ok: true, value: 2 }),
    branch: async () => ({ ok: true, value: "topics/card" }),
    repo: async () => ({ ok: true, value: "o/r" }),
    push: async (_cwd, sha, branch, lease) => { calls.push.push({ sha, branch, lease }); return { ok: true, value: "pushed" }; },
    remoteHead: async () => ({ ok: true, value: "c".repeat(40) }),
    inReflog: async () => ({ ok: true, value: false }),
    draftPullRequest: async () => { calls.pr += 1; return { ok: true, value: { number: 5, url: "https://github.com/o/r/pull/5" } }; },
    runs: async () => { calls.runs += 1; return { ok: true, value: [run()] }; },
    jobs: async () => ({ ok: true, value: green }),
    mergeState: async () => { calls.merge += 1; return { ok: true, value: "MERGEABLE" }; },
    ...over,
  };
  // Keep the counters when a test overrides a counted method.
  if (over.runs) { const inner = over.runs; port.runs = async (...a) => { calls.runs += 1; return inner(...a); }; }
  if (over.push) { const inner = over.push; port.push = async (...a) => { calls.push.push({ sha: a[1], branch: a[2], lease: a[3] }); return inner(...a); }; }
  if (over.mergeState) { const inner = over.mergeState; port.mergeState = async (...a) => { calls.merge += 1; return inner(...a); }; }
  return { port, calls };
}

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

const input = { cwd: "/tmp/wt", sha: SHA, taskId: "12345678-card" };

describe("awaitE2eEvidence", () => {
  test("a gh auth error on the pull request is NOT MEASURED at once, without polling", async () => {
    const { port, calls } = fakePort({ draftPullRequest: async () => ({ ok: false, error: "gh: not logged in" }) });
    const row = await awaitE2eEvidence(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.code).toBe(97);
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("not logged in");
    expect(calls.runs).toBe(0);
  });

  test("a rejected push with a remote head outside the reflog never forces", async () => {
    const { port, calls } = fakePort({ push: async () => ({ ok: true, value: "non-fast-forward" }) });
    const row = await awaitE2eEvidence(input, { port, ...fakeClock(), stopping: () => false });
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
    const row = await awaitE2eEvidence(input, { port, ...fakeClock(), stopping: () => false });
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
    const row = await awaitE2eEvidence(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
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
    const row = await awaitE2eEvidence(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("conflicts");
    expect(calls.merge).toBe(1);
    expect(clock.now() - start).toBeLessThan(10 * 60_000);
  });

  test("three failed reads then green is a pass; five in a row is NOT MEASURED", async () => {
    let n = 0;
    const flaky = fakePort({ runs: async () => (++n <= 3 ? { ok: false, error: "HTTP 502" } : { ok: true, value: [run()] }) });
    const pass = await awaitE2eEvidence(input, { port: flaky.port, ...fakeClock(), stopping: () => false });
    expect(pass.ok).toBe(true);
    const down = fakePort({ runs: async () => ({ ok: false, error: "HTTP 502" }) });
    const nm = await awaitE2eEvidence(input, { port: down.port, ...fakeClock(), stopping: () => false });
    expect(nm.notMeasured).toBe(true);
    expect(down.calls.runs).toBe(5);
  });

  test("a shutdown during the sleep rejects with ChecksInterruptedError", async () => {
    const clock = fakeClock();
    let stop = false;
    const { port } = fakePort({ runs: async () => ({ ok: true, value: [] }) });
    const sleep = async (ms: number) => { clock.advance(ms); stop = true; };
    await expect(awaitE2eEvidence(input, { port, now: clock.now, sleep, stopping: () => stop })).rejects.toBeInstanceOf(ChecksInterruptedError);
  });

  test("no commit beyond main is green with a note, and nothing is pushed or opened", async () => {
    const { port, calls } = fakePort({ ownCommits: async () => ({ ok: true, value: 0 }) });
    const row = await awaitE2eEvidence(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.ok).toBe(true);
    expect(row.tail).toContain("no commit of its own");
    expect(calls.push.length).toBe(0);
    expect(calls.pr).toBe(0);
  });

  test("the push carries the measured commit, not HEAD", async () => {
    const { port, calls } = fakePort();
    const row = await awaitE2eEvidence(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.ok).toBe(true);
    expect(calls.push).toEqual([{ sha: SHA, branch: "topics/card", lease: undefined }]);
    expect(row.tail).toContain("pull/5");
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
      const row = await awaitE2eEvidence(input, { port, ...fakeClock(), stopping: () => false });
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
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
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
      const row = await awaitE2eEvidence({ cwd: wt, sha, taskId: "12345678-card" }, { port, ...fakeClock(), stopping: () => false });
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

  test("the client waits past the CI deadline plus the slowest local round, and below the CLI tool timeout", () => {
    const legsMs = CHECKS_MAX_LEGS * CHECKS_LEG_MS;
    expect(CI_E2E_DEADLINE_MS + 30 * 60_000).toBeLessThanOrEqual(legsMs);
    expect(legsMs).toBeLessThan(ASK_TTL_MS + 5 * 60_000);
  });
});
