/**
 * The e2e evidence of a delivery, read from the pull request CI (KANBAN-84).
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
 *     head is that commit, and reads only `prepare-e2e` and `e2e (N)`.
 * Green only when every e2e job concluded `success`; red on any `failure`;
 * anything else is NOT MEASURED (exit 97), never a pass.
 *
 * Between two polls no child process is alive: each git/gh call is a short argv
 * spawn at agent priority with its own 60 s cap, and it never throws.
 */
import { E2E_CI_CHECK, type CheckRun, type ReviewCheck } from "../../shared/board";
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

export type GithubJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
};

export type E2eEvidence =
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
export function readE2eEvidence(sha: string, runs: GithubRun[], jobs: GithubJob[]): E2eEvidence {
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
export function ciCheckRun(check: ReviewCheck, outcome: Exclude<E2eEvidence, { kind: "pending" }>, ms: number, ctx: RunContext = {}): CheckRun {
  if (outcome.kind === "notMeasured") return ciNotMeasured(check, outcome.reason, { ...ctx, ms, run: outcome.run });
  const jobList = `jobs: ${outcome.jobs.map((j) => `${j.name} ${j.conclusion}`).join(", ")}`;
  if (outcome.kind === "pass") {
    return {
      name: check.name, cmd: check.cmd, ok: true, code: 0, ms, timedOut: false,
      tail: ["e2e green on the pull request CI", ...contextLines(outcome.run, ctx), jobList].join("\n"),
    };
  }
  const repoFlag = ctx.repo ? ` -R ${ctx.repo}` : "";
  return {
    name: check.name, cmd: check.cmd, ok: false, code: 1, ms, timedOut: false,
    tail: [
      `e2e red on the pull request CI: ${outcome.failed.map((j) => j.name).join(", ")}`,
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
}

type Spawned = { code: number; out: string; err: string };

async function spawnCapped(argv: string[], cwd: string): Promise<Spawned> {
  try {
    const proc = Bun.spawn(lowPriorityArgv(argv), {
      cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, CI_CALL_TIMEOUT_MS);
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out, err };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
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
      (o) => (JSON.parse(o) as { workflow_runs: GithubRun[] }).workflow_runs),
    jobs: (repo, runId) => call(["gh", "api", `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`], process.cwd(),
      (o) => (JSON.parse(o) as { jobs: GithubJob[] }).jobs),
    mergeState: (repo, pr) => call(["gh", "pr", "view", String(pr), "--repo", repo, "--json", "mergeable"], process.cwd(),
      (o) => String((JSON.parse(o) as Record<string, unknown>).mergeable ?? "")),
  };
}

export type AwaitE2eDeps = {
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
 * Pushes the measured commit, opens or reuses the draft PR and waits for the e2e
 * verdict of that commit. Resolves with a CheckRun (pass, fail or NOT MEASURED);
 * rejects only with ChecksInterruptedError when the server stops the checks.
 */
export async function awaitE2eEvidence(
  input: { cwd: string; sha: string; taskId: string },
  deps: AwaitE2eDeps = {},
): Promise<CheckRun> {
  const port = deps.port ?? githubPort();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stopping = deps.stopping ?? reviewChecksStopping;
  const pollMs = deps.pollMs ?? CI_POLL_MS;
  const deadlineMs = deps.deadlineMs ?? CI_E2E_DEADLINE_MS;
  const graceMs = deps.noRunGraceMs ?? CI_NO_RUN_GRACE_MS;
  const errorsMax = deps.apiErrorsMax ?? CI_API_ERRORS_MAX;
  const check = E2E_CI_CHECK;
  const { cwd, sha } = input;
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
  const notMeasured = (reason: string, ctx: RunContext & { run?: GithubRun | null } = {}) =>
    ciNotMeasured(check, reason, { ...ctx, ms: elapsed() });

  halt();
  const own = await port.ownCommits(cwd, sha, CI_BASE_BRANCH);
  if (!own.ok) return notMeasured(`cannot count the commits beyond ${CI_BASE_BRANCH}: ${own.error}`);
  if (own.value === 0) {
    return {
      name: check.name, cmd: check.cmd, ok: true, code: 0, ms: elapsed(), timedOut: false,
      tail: `no commit of its own beyond ${CI_BASE_BRANCH}: nothing to push, no CI to read`,
    };
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
      "to run the e2e jobs of the pull request CI. Not a request to merge: a person marks it ready when the card lands.");
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
    let outcome: E2eEvidence | null = null;
    if (runs.ok) {
      const run = latestCiRun(sha, runs.value);
      const jobs = run ? await port.jobs(repo.value, run.id) : { ok: true as const, value: [] };
      if (jobs.ok) {
        errors = 0;
        outcome = readE2eEvidence(sha, runs.value, jobs.value);
      } else {
        errors += 1;
        lastError = jobs.error;
      }
    } else {
      errors += 1;
      lastError = runs.error;
    }
    if (errors >= errorsMax) return notMeasured(`${errors} GitHub reads failed in a row: ${lastError}`, { ...ctx, run: lastRun });
    if (outcome && outcome.kind !== "pending") return ciCheckRun(check, outcome, elapsed(), ctx);
    if (outcome) lastRun = outcome.run;
    const waited = now() - pushedAt;
    if (outcome && !outcome.run && !conflictProbed && waited >= graceMs) {
      conflictProbed = true;
      const state = await port.mergeState(repo.value, pr.value.number);
      if (state.ok && state.value === "CONFLICTING") {
        return notMeasured("the pull request conflicts with main, so no CI run starts", ctx);
      }
    }
    if (waited >= deadlineMs) {
      return notMeasured(`no e2e verdict ${Math.round(deadlineMs / 60_000)} minutes after the push`, { ...ctx, run: lastRun });
    }
    await pause(pollMs);
  }
}
