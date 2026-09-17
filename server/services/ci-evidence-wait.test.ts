/**
 * The wait loop around the readers: the push that opens the round, the draft
 * pull request, the polling, the conflict probe, the links the card shows, and
 * the caps on the calls it makes. What that loop CONCLUDES is
 * `ci-evidence-verdict.test.ts`; what a single answer says is
 * `ci-evidence.test.ts`.
 *
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_CI_CHECK, UNIT_CI_CHECK } from "../../shared/board";
import {
  CI_E2E_DEADLINE_MS,
  awaitCiEvidence,
  githubPort,
  listField,
  spawnCapped,
  type GithubRun,
} from "./ci-evidence";
import { ChecksInterruptedError } from "./checks-gate";
import { SHA, checkJob, e2eRow, fakeClock, fakePort, green, input, job, run } from "./ci-evidence.testkit";

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

  test("the push carries the measured commit, not HEAD", async () => {
    const { port, calls } = fakePort();
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.ok).toBe(true);
    expect(calls.push).toEqual([{ sha: SHA, branch: "topics/card", lease: undefined }]);
    expect(row.tail).toContain("pull/5");
  });
});

describe("the conflict probe", () => {
  test("survives an unreadable and an UNKNOWN answer, and still finds the conflict", async () => {
    let probes = 0;
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [] }),
      mergeState: async () => {
        probes += 1;
        if (probes === 1) return { ok: false, error: "HTTP 502" };
        if (probes === 2) return { ok: true, value: "UNKNOWN" };
        return { ok: true, value: "CONFLICTING" };
      },
    });
    const clock = fakeClock();
    const row = await e2eRow(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.merge).toBe(3);
    expect(row.tail).toContain("conflicts");
  });

  test("is spent by a conclusive MERGEABLE: asked once, then the deadline", async () => {
    const clock = fakeClock();
    const { port, calls } = fakePort({ runs: async () => ({ ok: true, value: [] }) });
    const row = await e2eRow(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.merge).toBe(1);
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("no CI verdict");
  });
});

describe("the links of the wait", () => {
  test("the pull request travels before any run, the run at the poll that sees it", async () => {
    let polls = 0;
    const seen: Array<{ prUrl: string; runUrl?: string }> = [];
    const { port } = fakePort({ runs: async () => ({ ok: true, value: ++polls >= 2 ? [run()] : [] }) });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false, onCiWait: (l) => { seen.push(l); } });
    expect(row.ok).toBe(true);
    expect(seen).toEqual([
      { prUrl: "https://github.com/o/r/pull/5" },
      { prUrl: "https://github.com/o/r/pull/5", runUrl: "https://github.com/o/r/actions/runs/10" },
    ]);
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
