/**
 * The e2e and unit evidence of a delivery, read from the pull request CI (KANBAN-84).
 *
 * WHY IT EXISTS. Until 15/09/2026 the board's sixth check was
 * `bun run check:e2e-touched`, which runs Playwright with Chromium inside the
 * agent's worktree. That night agents downloaded Chromium onto the owner's Mac
 * to run it, where no Chromium may live. The same measurement, and more, already
 * runs in the `CI` workflow of every pull request: the PR tier on four shards
 * plus the touched specs in shard 1.
 *
 * WHAT IT DOES. After every local command of the delivery is green (the gate gave
 * its lane back first), the server, never the agent:
 *  1. pushes the EXACT measured commit to the card's branch, forcing only with a
 *     lease on a remote head this branch's reflog already had;
 *  2. opens or reuses a draft pull request towards main;
 *  3. polls GitHub every minute for the latest `pull_request` run of ci.yml whose
 *     head is that commit, and reads only `prepare-e2e` and `e2e (N)` for the
 *     e2e row, and only the step "Unit + integration tests" of the `check` job
 *     for the unit row.
 * Green only when every e2e job (or that step) concluded `success`; red on a
 * `failure`; anything else is NOT MEASURED (exit 97), never a pass.
 *
 * With both rows declared the delivery pushes once, opens one draft and runs one
 * poll loop: both verdicts come from the same run of the same commit.
 *
 * NOT MEASURED IS AN OUTCOME, NOT A DEAD END (KANBAN-85). A run that ENDED
 * without a verdict — cancelled, superseded, finished without the job or the
 * step a row reads — cannot be read again: re-delivering the same commit pushes
 * nothing (the branch is already there), reuses the same draft and finds the
 * same dead run. Measured on 17/09/2026: 15 of the last 100 shas with a
 * `pull_request` run of ci.yml were already in that state. So the loop asks
 * GitHub for ONE more attempt of that run (the rerun changes `run_attempt`, not
 * the sha) and keeps polling; when it cannot, the row says that only a new
 * commit unblocks it. It also leaves at the first red instead of waiting out the
 * other row — the same rule the local commands follow — and a branch with no
 * commit of its own is NOT MEASURED, never two greens.
 *
 * ONE RERUN PER RUN, AND `run_attempt` IS WHERE THAT IS WRITTEN. Nothing in this
 * process may count the rerun: the delivery is a row on `pending_deliveries`
 * that `resumePendingDeliveries` re-issues on the same commit after every
 * restart (44 of them in 25.7 hours against a CI wait of 15-25 minutes), so a
 * local flag asks again at every boot. The attempt number of the run answers
 * both ends of it: above 1 the rerun is already spent, and a rerun of ours is
 * only observed once it has grown.
 *
 * Between two polls no child process is alive: each git/gh call is a short argv
 * spawn at agent priority with its own 60 s cap on its whole process group, and it
 * never throws.
 */
import { spawn } from "node:child_process";
import { NOT_MEASURED_EXIT, UNIT_CI_CHECK, type CheckRun, type ReviewCheck } from "../../shared/board";
import { lowPriorityArgv } from "../lib/low-priority";
import { ChecksInterruptedError } from "./checks-gate";
import { reviewChecksStopping } from "./review-checks-brakes";

/** No verdict this long after the push is NOT MEASURED (42 min measured in a 10-PR burst). */
export const CI_E2E_DEADLINE_MS = 60 * 60_000;
/** A run lasts at least 14 minutes: one read a minute is plenty. */
export const CI_POLL_MS = 60_000;
/** A run is created within seconds; past this, a missing run asks whether the PR conflicts. */
export const CI_NO_RUN_GRACE_MS = 5 * 60_000;
/** Consecutive failed GitHub reads that end the wait. */
export const CI_API_ERRORS_MAX = 5;
/**
 * Reads granted to a rerun before it counts as never happened. `gh run rerun`
 * exits 0 the moment GitHub accepts the request, but `actions/runs?head_sha=`
 * kept answering with the old attempt for a while, and `cancel-in-progress` can
 * cancel the new one straight away. Every other GitHub read of this loop already
 * has `CI_API_ERRORS_MAX` tries before it concludes; this one had exactly one,
 * and a single stale read closed the round with "only a new commit can" while
 * the new attempt was running and would go green.
 */
export const CI_RERUN_READS_MAX = CI_API_ERRORS_MAX;
/** A git or gh call that hangs is an error, not a wait. */
export const CI_CALL_TIMEOUT_MS = 60_000;
export const CI_CONFIG_PATH = ".github/workflows/ci.yml";
export const CI_BASE_BRANCH = "main";

/** What unblocks a row whose run ended without a verdict, in the words of the card. */
const NEEDS_A_NEW_COMMIT = "this same commit cannot be measured again, only a new commit can";
const NO_OWN_COMMIT =
  `no commit of its own beyond ${CI_BASE_BRANCH}: nothing was pushed and no CI run reads this delivery, so ${NEEDS_A_NEW_COMMIT}`;
const E2E_JOB = /^e2e( \(\d+\))?$/;
const PREPARE_JOB = "prepare-e2e";
/** The job and step of ci.yml whose conclusion is the unit verdict. */
export const UNIT_JOB = "check";
export const UNIT_STEP = "Unit + integration tests";

export type GithubRun = {
  id: number;
  head_sha: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_attempt?: number;
};

export type GithubStep = {
  name: string;
  status: string;
  conclusion: string | null;
};

export type GithubJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  steps?: GithubStep[];
};

export type CiEvidence =
  | { kind: "pending"; run: GithubRun | null }
  | { kind: "pass"; run: GithubRun; jobs: GithubJob[] }
  | { kind: "fail"; run: GithubRun; jobs: GithubJob[]; failed: GithubJob[] }
  | { kind: "notMeasured"; run: GithubRun | null; reason: string };

/** `git@github.com:owner/name.git` or `https://github.com/owner/name(.git)` to `owner/name`. */
export function repoFromRemote(url: string): string | null {
  const m = url.trim().match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : null;
}

/** `git push --porcelain` refused the ref because the remote moved on. */
export function pushRejectedAsNonFastForward(porcelainOut: string): boolean {
  return /\[rejected\] \((non-fast-forward|fetch first)\)/.test(porcelainOut);
}

/**
 * Which attempt of a run this is, 1 when GitHub does not say. It is the only
 * trace of a rerun that survives a restart of this server: a run re-run keeps
 * its id and its sha and only this number grows.
 */
export const runAttempt = (run: GithubRun): number => {
  const n = Math.trunc(Number(run.run_attempt));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/** The run whose verdict counts: ci.yml, `pull_request`, this very commit, highest id. */
export function latestCiRun(sha: string, runs: GithubRun[]): GithubRun | null {
  const mine = runs.filter((r) => r.head_sha === sha && r.event === "pull_request"
    && (r.path === CI_CONFIG_PATH || r.path.startsWith(`${CI_CONFIG_PATH}@`)));
  return mine.reduce<GithubRun | null>((best, r) => (!best || r.id > best.id ? r : best), null);
}

/** The e2e outcome of `sha`, given the runs listed for it and the jobs of its latest run. */
export function readE2eEvidence(sha: string, runs: GithubRun[], jobs: GithubJob[]): CiEvidence {
  const run = latestCiRun(sha, runs);
  if (!run) return { kind: "pending", run: null };
  if (run.status === "completed" && run.conclusion === "cancelled") {
    return { kind: "notMeasured", run, reason: "the latest CI run for this commit was cancelled or superseded" };
  }
  const prepare = jobs.find((j) => j.name === PREPARE_JOB);
  if (prepare && prepare.status === "completed" && prepare.conclusion !== "success") {
    return { kind: "notMeasured", run, reason: `${PREPARE_JOB} concluded ${prepare.conclusion ?? "without a conclusion"}: the e2e shards did not run` };
  }
  const e2e = jobs.filter((j) => E2E_JOB.test(j.name));
  if (e2e.length === 0) {
    return run.status === "completed"
      ? { kind: "notMeasured", run, reason: "the CI run finished without any e2e job" }
      : { kind: "pending", run };
  }
  if (!e2e.every((j) => j.status === "completed")) return { kind: "pending", run };
  const failed = e2e.filter((j) => j.conclusion === "failure");
  if (failed.length) return { kind: "fail", run, jobs: e2e, failed };
  if (e2e.every((j) => j.conclusion === "success")) return { kind: "pass", run, jobs: e2e };
  const odd = e2e.filter((j) => j.conclusion !== "success").map((j) => `${j.name} ${j.conclusion ?? "none"}`);
  return { kind: "notMeasured", run, reason: `e2e jobs without a verdict: ${odd.join(", ")}` };
}

/**
 * The unit outcome of `sha`: the conclusion of the step "Unit + integration tests"
 * of job `check` in its latest run. The step is read as soon as it completes, even
 * while the rest of the job runs. A step skipped or cancelled, a job that ended
 * before the step (its setup failed), or no such step is NOT MEASURED, never green.
 */
export function readUnitEvidence(sha: string, runs: GithubRun[], jobs: GithubJob[]): CiEvidence {
  const run = latestCiRun(sha, runs);
  if (!run) return { kind: "pending", run: null };
  if (run.status === "completed" && run.conclusion === "cancelled") {
    return { kind: "notMeasured", run, reason: "the latest CI run for this commit was cancelled or superseded" };
  }
  const job = jobs.find((j) => j.name === UNIT_JOB);
  if (!job) {
    return run.status === "completed"
      ? { kind: "notMeasured", run, reason: `the CI run finished without the ${UNIT_JOB} job` }
      : { kind: "pending", run };
  }
  const step = job.steps?.find((s) => s.name === UNIT_STEP);
  if (step?.status === "completed") {
    if (step.conclusion === "success") return { kind: "pass", run, jobs: [job] };
    if (step.conclusion === "failure") return { kind: "fail", run, jobs: [job], failed: [job] };
    return { kind: "notMeasured", run, reason: `the step "${UNIT_STEP}" concluded ${step.conclusion ?? "without a conclusion"}` };
  }
  if (job.status !== "completed") return { kind: "pending", run };
  return {
    kind: "notMeasured", run,
    reason: step
      ? `the ${UNIT_JOB} job concluded ${job.conclusion ?? "without a conclusion"} before the step "${UNIT_STEP}" finished`
      : `the ${UNIT_JOB} job concluded ${job.conclusion ?? "without a conclusion"} without running the step "${UNIT_STEP}"`,
  };
}

const isUnitRow = (check: ReviewCheck): boolean => check.cmd.trim() === UNIT_CI_CHECK.cmd;

/** The outcome a declared CI row reads from the same run. */
export function readCiEvidence(check: ReviewCheck, sha: string, runs: GithubRun[], jobs: GithubJob[]): CiEvidence {
  return isUnitRow(check) ? readUnitEvidence(sha, runs, jobs) : readE2eEvidence(sha, runs, jobs);
}

type RunContext = { repo?: string; prUrl?: string };

function contextLines(run: GithubRun | null, ctx: RunContext): string[] {
  return [
    ...(ctx.prUrl ? [`PR: ${ctx.prUrl}`] : []),
    ...(run ? [`run: ${run.html_url}`] : []),
  ];
}

/** A NOT MEASURED row: code 97, the reason first. Never `timedOut`. */
export function ciNotMeasured(check: ReviewCheck, reason: string, extra: RunContext & { ms?: number; run?: GithubRun | null } = {}): CheckRun {
  return {
    name: check.name, cmd: check.cmd, ok: false, code: NOT_MEASURED_EXIT, ms: extra.ms ?? 0,
    timedOut: false, notMeasured: true,
    tail: [`NOT MEASURED: ${reason}`, ...contextLines(extra.run ?? null, extra)].join("\n"),
  };
}

/** The CheckRun of a settled outcome (a pending one is not a row). */
export function ciCheckRun(check: ReviewCheck, outcome: Exclude<CiEvidence, { kind: "pending" }>, ms: number, ctx: RunContext = {}): CheckRun {
  if (outcome.kind === "notMeasured") return ciNotMeasured(check, outcome.reason, { ...ctx, ms, run: outcome.run });
  const unit = isUnitRow(check);
  const label = unit ? "unit tests" : "e2e";
  const jobList = unit
    ? `step "${UNIT_STEP}" of job ${UNIT_JOB}: ${outcome.kind === "pass" ? "success" : "failure"}`
    : `jobs: ${outcome.jobs.map((j) => `${j.name} ${j.conclusion}`).join(", ")}`;
  if (outcome.kind === "pass") {
    return {
      name: check.name, cmd: check.cmd, ok: true, code: 0, ms, timedOut: false,
      tail: [`${label} green on the pull request CI`, ...contextLines(outcome.run, ctx), jobList].join("\n"),
    };
  }
  const repoFlag = ctx.repo ? ` -R ${ctx.repo}` : "";
  return {
    name: check.name, cmd: check.cmd, ok: false, code: 1, ms, timedOut: false,
    tail: [
      `${label} red on the pull request CI: ${outcome.failed.map((j) => j.name).join(", ")}`,
      ...contextLines(outcome.run, ctx),
      jobList,
      ...outcome.failed.map((j) => `log of ${j.name}: gh run view --job ${j.id} --log-failed${repoFlag}`),
    ].join("\n"),
  };
}

/** A call's answer: a value, or the error it came back with. Never an exception. */
export type Got<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GithubPort {
  ownCommits(cwd: string, sha: string, base: string): Promise<Got<number>>;
  branch(cwd: string): Promise<Got<string>>;
  repo(cwd: string): Promise<Got<string>>;
  push(cwd: string, sha: string, branch: string, lease?: string): Promise<Got<"pushed" | "non-fast-forward">>;
  remoteHead(cwd: string, branch: string): Promise<Got<string | null>>;
  inReflog(cwd: string, branch: string, sha: string): Promise<Got<boolean>>;
  draftPullRequest(cwd: string, repo: string, branch: string, title: string, body: string): Promise<Got<{ number: number; url: string }>>;
  runs(repo: string, sha: string): Promise<Got<GithubRun[]>>;
  jobs(repo: string, runId: number): Promise<Got<GithubJob[]>>;
  mergeState(repo: string, pr: number): Promise<Got<string>>;
  /** One more attempt of a run that ended without a verdict: same sha, new `run_attempt`. */
  rerun(repo: string, runId: number): Promise<Got<void>>;
}

type Spawned = { code: number; out: string; err: string };

/**
 * One git or gh call, capped for real. The child leads its own process group and
 * the cap kills the whole group, then answers without waiting for the pipes:
 * `git push` runs the pre-push hook and `ssh` as children, and a SIGKILL of git
 * alone left them holding stdout, so the call returned only when they exited
 * (96 s with a 95 s hook; never with an ssh on a half-open connection), and the
 * delivery's 60 minute deadline, checked only after the push, was never reached.
 */
/** How long the output of an exited call may keep draining through a lingering child. */
const EXIT_DRAIN_MS = 2_000;

export function spawnCapped(argv: string[], cwd: string, capMs = CI_CALL_TIMEOUT_MS): Promise<Spawned> {
  return new Promise((resolve) => {
    const ownGroup = process.platform !== "win32";
    let out = "";
    let err = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: Spawned) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const [bin, ...args] = lowPriorityArgv(argv);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin!, args, {
        cwd, detached: ownGroup, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      });
    } catch (e) {
      settle({ code: 127, out: "", err: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => settle({ code: 127, out, err: e.message }));
    child.on("close", (code, signal) => settle({ code: code ?? (signal ? 137 : 1), out, err }));
    // The call is over when git exits. A child it left behind holding the pipe
    // must not turn a finished push into a timeout: give the output a moment to
    // drain, then answer with git's own code and kill what is left.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        if (settled) return;
        try { if (ownGroup && child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        settle({ code: code ?? (signal ? 137 : 1), out, err });
      }, EXIT_DRAIN_MS).unref?.();
    });
    timer = setTimeout(() => {
      try {
        if (ownGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
      settle({ code: 137, out, err: `${err}\nkilled after ${Math.round(capMs / 1000)} s`.trim() });
    }, capMs);
  });
}

const failed = (argv: string[], r: Spawned): { ok: false; error: string } =>
  ({ ok: false, error: `${argv.slice(0, 3).join(" ")} exited ${r.code}: ${(r.err || r.out).trim().slice(0, 400)}` });

async function call<T>(argv: string[], cwd: string, parse: (out: string) => T): Promise<Got<T>> {
  const r = await spawnCapped(argv, cwd);
  if (r.code !== 0) return failed(argv, r);
  try { return { ok: true, value: parse(r.out) }; } catch (e) {
    return { ok: false, error: `${argv.slice(0, 3).join(" ")}: unreadable answer (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * The array under `field` of a GitHub answer, or an exception the caller turns
 * into a failed read. `gh api` can exit 0 with a body that has no such array
 * (`{"total_count":0}`, an error object): parsed as-is it was `undefined`, and
 * `runs.filter` threw far from here, inside the delivery.
 */
export function listField<T>(out: string, field: string): T[] {
  const value = (JSON.parse(out) as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(value)) throw new Error(`no "${field}" array in the answer`);
  return value as T[];
}

/** The real port: git and gh as argv spawns, never a shell string. */
export function githubPort(): GithubPort {
  return {
    ownCommits: (cwd, sha, base) => call(["git", "rev-list", "--count", `${base}..${sha}`], cwd, (o) => {
      const n = Number(o.trim());
      if (!Number.isInteger(n)) throw new Error("not a count");
      return n;
    }),
    branch: (cwd) => call(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd, (o) => o.trim()),
    repo: async (cwd) => {
      const got = await call(["git", "remote", "get-url", "origin"], cwd, (o) => o.trim());
      if (!got.ok) return got;
      const repo = repoFromRemote(got.value);
      return repo ? { ok: true, value: repo } : { ok: false, error: `origin is not a GitHub repository (${got.value})` };
    },
    push: async (cwd, sha, branch, lease) => {
      const argv = ["git", "push", "--porcelain",
        ...(lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : []),
        "origin", `${sha}:refs/heads/${branch}`];
      const r = await spawnCapped(argv, cwd);
      if (r.code === 0) return { ok: true, value: "pushed" };
      if (!lease && pushRejectedAsNonFastForward(`${r.out}\n${r.err}`)) return { ok: true, value: "non-fast-forward" };
      return failed(argv, r);
    },
    remoteHead: (cwd, branch) => call(["git", "ls-remote", "origin", `refs/heads/${branch}`], cwd,
      (o) => o.trim().split(/\s+/)[0] || null),
    inReflog: (cwd, branch, sha) => call(["git", "reflog", "show", "--format=%H", `refs/heads/${branch}`], cwd,
      (o) => o.split("\n").some((l) => l.trim() === sha)),
    draftPullRequest: async (cwd, repo, branch, title, body) => {
      const open = await call(["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"], cwd,
        (o) => JSON.parse(o) as { number: number; url: string }[]);
      if (!open.ok) return open;
      if (open.value[0]) return { ok: true, value: open.value[0] };
      return call(["gh", "pr", "create", "--repo", repo, "--draft", "--base", CI_BASE_BRANCH, "--head", branch, "--title", title, "--body", body], cwd, (o) => {
        const url = o.trim().split("\n").pop() ?? "";
        const n = Number(url.match(/\/pull\/(\d+)/)?.[1]);
        if (!n) throw new Error(`no pull request URL in "${url}"`);
        return { number: n, url };
      });
    },
    runs: (repo, sha) => call(["gh", "api", `repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=20`], process.cwd(),
      (o) => listField<GithubRun>(o, "workflow_runs")),
    jobs: (repo, runId) => call(["gh", "api", `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`], process.cwd(),
      (o) => listField<GithubJob>(o, "jobs")),
    mergeState: (repo, pr) => call(["gh", "pr", "view", String(pr), "--repo", repo, "--json", "mergeable"], process.cwd(),
      (o) => String((JSON.parse(o) as Record<string, unknown>).mergeable ?? "")),
    rerun: (repo, runId) => call(["gh", "run", "rerun", String(runId), "--repo", repo], process.cwd(), () => undefined),
  };
}

export type AwaitCiDeps = {
  port?: GithubPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stopping?: () => boolean;
  pollMs?: number;
  deadlineMs?: number;
  noRunGraceMs?: number;
  apiErrorsMax?: number;
  /**
   * The links of the wait, as soon as they exist: the draft pull request right
   * after it is opened, the run at the first poll that sees it. Both were born
   * within seconds and reached the card only in the `tail` of the verdict, a
   * quarter of an hour later (run 35158365969: 22:34:48 to 22:49:48), so while
   * GitHub measured, the card had nothing to open. Called at most once per link
   * and never allowed to throw into the loop.
   */
  onCiWait?: (links: { prUrl: string; runUrl?: string }) => void;
};

/**
 * Pushes the measured commit, opens or reuses the draft PR and waits for the
 * verdict of every declared CI row on that commit: one push, one draft, one poll
 * loop for all of them. Resolves with one CheckRun per row, in the order given
 * (pass, fail or NOT MEASURED); rejects only with ChecksInterruptedError when the
 * server stops the checks.
 */
export async function awaitCiEvidence(
  input: { cwd: string; sha: string; taskId: string; checks: readonly ReviewCheck[] },
  deps: AwaitCiDeps = {},
): Promise<CheckRun[]> {
  const port = deps.port ?? githubPort();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stopping = deps.stopping ?? reviewChecksStopping;
  const pollMs = deps.pollMs ?? CI_POLL_MS;
  const deadlineMs = deps.deadlineMs ?? CI_E2E_DEADLINE_MS;
  const graceMs = deps.noRunGraceMs ?? CI_NO_RUN_GRACE_MS;
  const errorsMax = deps.apiErrorsMax ?? CI_API_ERRORS_MAX;
  const { cwd, sha, checks } = input;
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const halt = () => { if (stopping()) throw new ChecksInterruptedError(); };
  // Slept in one-second slices so a shutdown is noticed within a second.
  const pause = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      halt();
      await sleep(Math.min(1_000, left));
    }
    halt();
  };
  const settled = new Map<ReviewCheck, CheckRun>();
  const open = () => checks.filter((c) => !settled.has(c));
  // Every row still open gets the same reason; the rows already settled keep theirs.
  const notMeasured = (reason: string, ctx: RunContext & { run?: GithubRun | null } = {}): CheckRun[] =>
    checks.map((c) => settled.get(c) ?? ciNotMeasured(c, reason, { ...ctx, ms: elapsed() }));

  halt();
  const own = await port.ownCommits(cwd, sha, CI_BASE_BRANCH);
  if (!own.ok) return notMeasured(`cannot count the commits beyond ${CI_BASE_BRANCH}: ${own.error}`);
  // A GREEN THAT MEASURED NOTHING IS NOT A GREEN (`review-checks.ts` says it of
  // the local rails, and these rows exist for the same reason). Until 17/09/2026
  // a branch with nothing of its own beyond main came back as TWO greens with a
  // note in the tail — the shortest path there is to deliver a branch that
  // measures nothing at all.
  if (own.value === 0) return notMeasured(NO_OWN_COMMIT);
  const branch = await port.branch(cwd);
  if (!branch.ok || !branch.value) return notMeasured(`the worktree is not on a branch${branch.ok ? "" : `: ${branch.error}`}`);
  const repo = await port.repo(cwd);
  if (!repo.ok) return notMeasured(repo.error);

  halt();
  const pushed = await port.push(cwd, sha, branch.value);
  if (!pushed.ok) return notMeasured(`push failed: ${pushed.error}`);
  if (pushed.value === "non-fast-forward") {
    const head = await port.remoteHead(cwd, branch.value);
    if (!head.ok || !head.value) return notMeasured(`push rejected and the remote head is unreadable${head.ok ? "" : `: ${head.error}`}`);
    const known = await port.inReflog(cwd, branch.value, head.value);
    if (!known.ok) return notMeasured(`push rejected and the branch reflog is unreadable: ${known.error}`);
    if (!known.value) {
      return notMeasured(`the remote branch ${branch.value} has commits this worktree never had (${head.value.slice(0, 8)}): left untouched`);
    }
    const forced = await port.push(cwd, sha, branch.value, head.value);
    if (!forced.ok || forced.value !== "pushed") return notMeasured(`push with lease failed${forced.ok ? "" : `: ${forced.error}`}`);
  }

  const pr = await port.draftPullRequest(cwd, repo.value, branch.value,
    `board: ${branch.value} (card ${input.taskId.slice(0, 8)})`,
    `Draft opened by the Topics board for commit ${sha.slice(0, 8)} of card ${input.taskId.slice(0, 8)}, ` +
      "to read the pull request CI (e2e jobs, unit tests). Not a request to merge: a person marks it ready when the card lands.");
  if (!pr.ok) return notMeasured(`cannot open or find the draft pull request: ${pr.error}`);
  const ctx: RunContext = { repo: repo.value, prUrl: pr.value.url };
  const pushedAt = now();
  let toldRunUrl = "";
  const tellWait = (runUrl?: string) => {
    try { deps.onCiWait?.({ prUrl: pr.value.url, ...(runUrl ? { runUrl } : {}) }); }
    catch { /* a link on the card: it must never stop the wait */ }
  };
  tellWait();

  let errors = 0;
  let lastError = "";
  let conflictProbed = false;
  let rerunTried = false;
  let rerunError = "";
  /** The attempt a rerun of ours has to beat before a read is conclusive again, 0 when none is pending. */
  let rerunAwaitedAttempt = 0;
  let rerunReadsLeft = 0;
  let lastRun: GithubRun | null = null;
  /** A row whose run ended without a verdict says what unblocks it, once the rerun is spent. */
  type Settled = Exclude<CiEvidence, { kind: "pending" }>;
  const deadEnd = (outcome: Settled): Settled =>
    outcome.kind === "notMeasured" && rerunTried
      ? {
        ...outcome,
        reason: `${outcome.reason}; ${rerunError
          ? `asking GitHub to re-run it failed (${rerunError})`
          : "it was re-run once and still has no verdict"}: ${NEEDS_A_NEW_COMMIT}`,
      }
      : outcome;
  for (;;) {
    halt();
    const runs = await port.runs(repo.value, sha);
    let read: { runs: GithubRun[]; jobs: GithubJob[] } | null = null;
    if (runs.ok) {
      const run = latestCiRun(sha, runs.value);
      const jobs = run ? await port.jobs(repo.value, run.id) : { ok: true as const, value: [] };
      if (jobs.ok) {
        errors = 0;
        read = { runs: runs.value, jobs: jobs.value };
      } else {
        errors += 1;
        lastError = jobs.error;
      }
    } else {
      errors += 1;
      lastError = runs.error;
    }
    if (errors >= errorsMax) return notMeasured(`${errors} GitHub reads failed in a row: ${lastError}`, { ...ctx, run: lastRun });
    let noRun = false;
    const page = read;
    const run = page ? latestCiRun(sha, page.runs) : null;
    if (run && run.html_url !== toldRunUrl) {
      toldRunUrl = run.html_url;
      tellWait(run.html_url);
    }
    // A REREAD THAT STILL SHOWS THE OLD ATTEMPT IS NOT A VERDICT. `gh run rerun`
    // answers when GitHub accepts the request, not when the new attempt is
    // listed, so the read right after it can still be the dead run.
    if (page && rerunAwaitedAttempt > 0) {
      if (run && runAttempt(run) > rerunAwaitedAttempt) rerunAwaitedAttempt = 0;
      else if (rerunReadsLeft > 0) rerunReadsLeft -= 1;
      else rerunAwaitedAttempt = 0; // the grace is spent: read the run as it is
    }
    if (page && rerunAwaitedAttempt === 0) {
      const outcomes = open().map((check) => ({ check, outcome: readCiEvidence(check, sha, page.runs, page.jobs) }));
      // Rows with no verdict on this run, the ones already closed included: a
      // row read as not measured while the run was still going (a `prepare-e2e`
      // that failed, a `check` job that died before its unit step) used to be
      // closed on the spot and never looked at again, so the run reaching
      // `completed` found nothing left open and the rerun below never fired.
      // Those are two of the three terminal cases KANBAN-85 names.
      const unmeasured = checks.filter((c) => {
        const done = settled.get(c);
        return done ? done.notMeasured === true
          : outcomes.find((o) => o.check === c)?.outcome.kind === "notMeasured";
      });
      // A RUN THAT ENDED WITHOUT A VERDICT: ONE MORE ATTEMPT, NOT ANOTHER GIRO.
      //
      // The readers answer `notMeasured` only when there is nothing left to wait
      // for, so a completed run with a row that has no verdict has nothing more
      // to give it. Re-delivering the same commit would push nothing (the branch
      // is already there), reuse the draft and find this same run: 15 of the
      // last 100 shas measured on 17/09/2026 were already parked there.
      // Only when the run itself is over, so a rerun cannot cut a shard still
      // running for the other row.
      if (run && run.status === "completed" && !rerunTried && unmeasured.length > 0) {
        rerunTried = true;
        // THE RERUN IS SPENT ONCE PER RUN, NOT ONCE PER CALL. `rerunTried` is a
        // local of this call, but the delivery it serves is a row on
        // `pending_deliveries` that `resumePendingDeliveries` re-issues on the
        // same commit at every boot, and this Mac restarted the server 44 times
        // in 25.7 hours against a CI wait of 15-25 minutes. The attempt number
        // is the state GitHub keeps for us: above 1 the rerun was already asked,
        // and this run is what it produced.
        if (runAttempt(run) === 1) {
          const again = await port.rerun(repo.value, run.id);
          if (again.ok) {
            // The new attempt re-measures every row that has no verdict; a row
            // already green or red measured something real on this commit.
            for (const [check, row] of [...settled]) if (row.notMeasured) settled.delete(check);
            rerunAwaitedAttempt = runAttempt(run);
            rerunReadsLeft = CI_RERUN_READS_MAX;
            await pause(pollMs);
            continue;
          }
          rerunError = again.error;
        }
      }
      for (const { check, outcome } of outcomes) {
        if (outcome.kind === "pending") {
          lastRun = outcome.run;
          noRun ||= !outcome.run;
          continue;
        }
        settled.set(check, ciCheckRun(check, deadEnd(outcome), elapsed(), ctx));
      }
      // ONE RED ENDS THE ROUND, like the local commands (`review-checks.ts`:
      // sequential, stop at the first red). An actionable red used to be
      // delivered 60 minutes late because the loop kept waiting for the other
      // row's verdict, which changes nothing about what the person has to do.
      const red = checks.map((c) => settled.get(c)).find((r) => r && !r.ok && !r.notMeasured);
      if (red) {
        return notMeasured(`the round stopped at the first red (${red.name}), so this row was not waited for`,
          { ...ctx, run: run ?? lastRun });
      }
      // A row without a verdict is not final while its run is still going: the
      // rerun above reopens it when the run completes, so leaving now would be
      // the dead end again with every row closed.
      const mayStillRerun = !rerunTried && !!run && run.status !== "completed" && unmeasured.length > 0;
      if (open().length === 0 && !mayStillRerun) return checks.map((c) => settled.get(c)!);
    }
    const waited = now() - pushedAt;
    if (noRun && !conflictProbed && waited >= graceMs) {
      const state = await port.mergeState(repo.value, pr.value.number);
      // ONLY A CONCLUSIVE ANSWER SPENDS THE PROBE. `UNKNOWN` (GitHub is still
      // computing the merge) and a failed read used to disarm it just the same,
      // and with the single way this loop has of recognising a conflict burnt on
      // the first try what was left was 55 minutes of mute waiting.
      if (state.ok && (state.value === "CONFLICTING" || state.value === "MERGEABLE")) conflictProbed = true;
      if (state.ok && state.value === "CONFLICTING") {
        return notMeasured("the pull request conflicts with main, so no CI run starts", ctx);
      }
    }
    if (waited >= deadlineMs) {
      return notMeasured(`no CI verdict ${Math.round(deadlineMs / 60_000)} minutes after the push`, { ...ctx, run: lastRun });
    }
    await pause(pollMs);
  }
}
