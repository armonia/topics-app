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
 * Between two polls no child process is alive: each git/gh call is a short argv
 * spawn at agent priority with its own 60 s cap on its whole process group, and it
 * never throws.
 */
import { spawn } from "node:child_process";
import { UNIT_CI_CHECK, type CheckRun, type ReviewCheck } from "../../shared/board";
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
/** A git or gh call that hangs is an error, not a wait. */
export const CI_CALL_TIMEOUT_MS = 60_000;
export const CI_CONFIG_PATH = ".github/workflows/ci.yml";
export const CI_BASE_BRANCH = "main";

const NOT_MEASURED_CODE = 97;
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
    name: check.name, cmd: check.cmd, ok: false, code: NOT_MEASURED_CODE, ms: extra.ms ?? 0,
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
  /** The open pull request whose head is `branch`, or null. The SAME lookup that opens the draft and the one that closes it. */
  openPullRequest(cwd: string, repo: string, branch: string): Promise<Got<PullRequestRef | null>>;
  draftPullRequest(cwd: string, repo: string, branch: string, title: string, body: string): Promise<Got<PullRequestRef>>;
  closePullRequest(cwd: string, repo: string, pr: number, comment: string): Promise<Got<"closed">>;
  /** `deleted`, or `absent` when the remote branch was already gone: both are "nothing left on origin". */
  deleteRemoteBranch(cwd: string, branch: string): Promise<Got<"deleted" | "absent">>;
  runs(repo: string, sha: string): Promise<Got<GithubRun[]>>;
  jobs(repo: string, runId: number): Promise<Got<GithubJob[]>>;
  mergeState(repo: string, pr: number): Promise<Got<string>>;
}

export type PullRequestRef = { number: number; url: string };

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
  // Hoisted out of the literal because `draftPullRequest` calls it: the draft is
  // opened only when this lookup finds none, and the cleanup closes whatever it
  // finds, so both doors ask GitHub the same question.
  const openPullRequest: GithubPort["openPullRequest"] = (cwd, repo, branch) => call(
    ["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"], cwd,
    (o) => (JSON.parse(o) as PullRequestRef[])[0] ?? null);
  return {
    openPullRequest,
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
    closePullRequest: (cwd, repo, pr, comment) => call(
      ["gh", "pr", "close", String(pr), "--repo", repo, "--comment", comment], cwd, () => "closed" as const),
    deleteRemoteBranch: async (cwd, branch) => {
      const argv = ["git", "push", "origin", "--delete", branch];
      const r = await spawnCapped(argv, cwd);
      if (r.code === 0) return { ok: true, value: "deleted" };
      // Already gone is the outcome we wanted, not a failure: the sweep runs on
      // the land, the superseded approval and the archive, and two of the three
      // can reach the same card.
      if (/remote ref does not exist/i.test(`${r.out}\n${r.err}`)) return { ok: true, value: "absent" };
      return failed(argv, r);
    },
    draftPullRequest: async (cwd, repo, branch, title, body) => {
      const open = await openPullRequest(cwd, repo, branch);
      if (!open.ok) return open;
      if (open.value) return { ok: true, value: open.value };
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
  if (own.value === 0) {
    return checks.map((check) => ({
      name: check.name, cmd: check.cmd, ok: true, code: 0, ms: elapsed(), timedOut: false,
      tail: `no commit of its own beyond ${CI_BASE_BRANCH}: nothing to push, no CI to read`,
    }));
  }
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

  let errors = 0;
  let lastError = "";
  let conflictProbed = false;
  let lastRun: GithubRun | null = null;
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
    if (read) {
      for (const check of open()) {
        const outcome = readCiEvidence(check, sha, read.runs, read.jobs);
        if (outcome.kind !== "pending") settled.set(check, ciCheckRun(check, outcome, elapsed(), ctx));
        else {
          lastRun = outcome.run;
          noRun ||= !outcome.run;
        }
      }
      if (open().length === 0) return checks.map((c) => settled.get(c)!);
    }
    const waited = now() - pushedAt;
    if (noRun && !conflictProbed && waited >= graceMs) {
      conflictProbed = true;
      const state = await port.mergeState(repo.value, pr.value.number);
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

/** What the sweep actually did, for the receipt on the card. */
export type DraftCleanup = {
  /** The pull request that was closed, or null when there was none open. */
  pr: PullRequestRef | null;
  /** True only when origin still had the branch and it is gone now. */
  branchDeleted: boolean;
  /** Why a half of it did not happen. Never thrown: this is housekeeping, not a gate. */
  problems: string[];
};

/**
 * Close the draft this module opened and delete its remote branch.
 *
 * WHY IT EXISTS. `awaitCiEvidence` opens a draft pull request for every delivery
 * that reaches review, and until 17/09/2026 nothing ever closed one: the four
 * `gh` calls of this file were `pr list`, `pr create`, `api .../runs|jobs` and
 * `pr view`, with no `pr close` and no `push --delete` anywhere in the tree. The
 * twin was already visible without the drafts - 41 `topics/*` branches on origin,
 * 39 of them already inside `main`, none ever deleted - and with 121 entries into
 * review in 7 days the drafts would pile up at the same rate.
 *
 * WHAT IT DOES NOT DO. It never merges and never marks a draft ready: the board
 * merges locally and a person publishes. Closing keeps the commits reachable on
 * GitHub through `refs/pull/N/head`, which is why the pull request is closed
 * BEFORE the branch is deleted rather than after.
 */
export async function closeCiDraft(
  input: { cwd: string; branch: string; reason: string },
  deps: { port?: GithubPort } = {},
): Promise<DraftCleanup> {
  const port = deps.port ?? githubPort();
  const out: DraftCleanup = { pr: null, branchDeleted: false, problems: [] };
  const branch = input.branch.trim();
  if (!branch) return out;
  // THE GUARD THAT MATTERS. A card that ran in place, with no worktree of its
  // own, records the checkout's own branch as its delivery branch - and that
  // branch is `main`. Deleting it on origin is the one move here that cannot be
  // undone from the Mac, so the integration branch and the branch this checkout
  // is sitting on are both refused, whatever the card says.
  if (branch === CI_BASE_BRANCH) {
    out.problems.push(`refused to touch ${CI_BASE_BRANCH}: that is the integration branch, not a delivery`);
    return out;
  }
  const here = await port.branch(input.cwd);
  if (here.ok && here.value === branch) {
    out.problems.push(`refused: the checkout ${input.cwd} is itself on ${branch}`);
    return out;
  }
  const repo = await port.repo(input.cwd);
  if (!repo.ok) {
    out.problems.push(repo.error);
    return out;
  }
  const open = await port.openPullRequest(input.cwd, repo.value, branch);
  if (!open.ok) out.problems.push(open.error);
  else if (open.value) {
    const closed = await port.closePullRequest(input.cwd, repo.value, open.value.number, input.reason);
    if (closed.ok) out.pr = open.value;
    else out.problems.push(closed.error);
  }
  const deleted = await port.deleteRemoteBranch(input.cwd, branch);
  if (!deleted.ok) out.problems.push(deleted.error);
  else out.branchDeleted = deleted.value === "deleted";
  return out;
}
