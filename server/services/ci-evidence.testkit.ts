/**
 * The fakes the `ci-evidence` tests share: a GitHub run, a job, a whole port
 * and a clock that never really sleeps.
 *
 * They live here because the tests that need them are THREE files and not one
 * any more (the readers, the wait loop, the verdict), and a `fakePort` copied
 * three times is a 20-line clone that `check:bloat` counts as duplication and
 * that drifts the moment one copy gains a method.
 */
import { awaitCiEvidence, UNIT_STEP, type AwaitCiDeps, type GithubJob, type GithubPort, type GithubRun } from "./ci-evidence";
import { E2E_CI_CHECK } from "../../shared/board";

export const SHA = "a".repeat(40);

export const run = (over: Partial<GithubRun> = {}): GithubRun => ({
  id: 10, head_sha: SHA, event: "pull_request", path: ".github/workflows/ci.yml",
  status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/10", ...over,
});

export const job = (name: string, conclusion: string | null, over: Partial<GithubJob> = {}): GithubJob => ({
  id: name.length * 100 + (conclusion?.length ?? 0), name, status: conclusion ? "completed" : "in_progress", conclusion, ...over,
});

/** The five jobs of a fully green e2e side: `prepare-e2e` and the four shards. */
export const green = [job("prepare-e2e", "success"), job("e2e (1)", "success"), job("e2e (2)", "success"), job("e2e (3)", "success"), job("e2e (4)", "success")];

export const step = (name: string, conclusion: string | null) => ({ name, status: conclusion ? "completed" : "in_progress", conclusion });

/** The `check` job with its unit step at the given conclusion (null = still running). */
export const checkJob = (unit: string | null, over: Partial<GithubJob> = {}): GithubJob => ({
  id: 4242, name: "check", status: "in_progress", conclusion: null,
  steps: [step("Setup Bun", "success"), step("Typecheck (client + server ratchet + e2e)", "success"), step(UNIT_STEP, unit)],
  ...over,
});

export type Calls = { push: Array<{ sha: string; branch: string; lease?: string }>; runs: number; pr: number; merge: number; rerun: number[] };

export function fakePort(over: Partial<GithubPort> = {}): { port: GithubPort; calls: Calls } {
  const calls: Calls = { push: [], runs: 0, pr: 0, merge: 0, rerun: [] };
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
    rerun: async (_repo, runId) => { calls.rerun.push(runId); return { ok: true, value: undefined }; },
    // The cleanup half of the port, added by the land round. The default is the
    // land case: the merge is on LOCAL main and nobody has pushed it yet, so
    // `origin/main` does not carry the branch and neither half fires. The tests
    // that exercise the cleanup live in `ci-evidence.test.ts` with their own port.
    contains: async () => ({ ok: true, value: false }),
    openPullRequest: async () => ({ ok: true, value: null }),
    closePullRequest: async () => ({ ok: true, value: "closed" }),
    deleteRemoteBranch: async () => ({ ok: true, value: "deleted" }),
    ...over,
  };
  // Keep the counters when a test overrides a counted method.
  if (over.runs) { const inner = over.runs; port.runs = async (...a) => { calls.runs += 1; return inner(...a); }; }
  if (over.push) { const inner = over.push; port.push = async (...a) => { calls.push.push({ sha: a[1], branch: a[2], lease: a[3] }); return inner(...a); }; }
  if (over.mergeState) { const inner = over.mergeState; port.mergeState = async (...a) => { calls.merge += 1; return inner(...a); }; }
  if (over.rerun) { const inner = over.rerun; port.rerun = async (...a) => { calls.rerun.push(a[1]); return inner(...a); }; }
  return { port, calls };
}

export function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

export const input = { cwd: "/tmp/wt", sha: SHA, taskId: "12345678-card" };

export const e2eRow = async (i: typeof input, d: AwaitCiDeps) => (await awaitCiEvidence({ ...i, checks: [E2E_CI_CHECK] }, d))[0]!;
