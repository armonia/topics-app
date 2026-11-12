#!/usr/bin/env bun
/**
 * scripts/test-touched-measure.ts - would `test:touched` have caught the reds CI saw?
 *
 * For every failed CI run whose `unit` job went red, it reads the red test files
 * from the job log, replays the selector on that commit's own diff, and says
 * whether each red file was included. A red file the selector left out is
 * either proven not to come from the diff or counted as a real false negative:
 *   - "red on main": the same file was red on a push to main within 24 h, so
 *     the diff was not the cause;
 *   - "green on rerun": another CI run of the same commit had a green `unit`
 *     job, so the red was a flake.
 * No proof means UNPROVEN, the exit code is 1, and the selector must widen
 * (pattern or fallback) or the case goes into WHAT IT DOES NOT CATCH.
 *
 * USAGE (needs `gh` logged in and network)
 *   bun run scripts/test-touched-measure.ts [--limit 100] [--runs 10]
 * --limit is how many failed CI runs to scan, --runs how many reds to measure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectForBase } from "./test-touched.ts";

const REPO = "armonia/topics-app";
const REPO_URL = `https://github.com/${REPO}.git`;
const WINDOW_MS = 24 * 3600 * 1000;
// The label the unit runner prints before the output of a failed file.
const RED_MARKER = /^─{3,} (\S+) FALLITO \(exit/; // allow-italian: matches the runner's output

type Run = { databaseId: number; event: string; headSha: string; headBranch: string; createdAt: string; displayTitle: string };
type Job = { name: string; conclusion: string | null; databaseId: number };

function sh(cmd: string[], cwd?: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
const gh = <T>(args: string[]): T => JSON.parse(sh(["gh", ...args]));

function unitJob(runId: number): Job | undefined {
  const { jobs } = gh<{ jobs: Job[] }>(["run", "view", String(runId), "--json", "jobs"]);
  return jobs.find((j) => j.name === "unit");
}

/** The test files the `unit` job of a run reported as red. */
function redFiles(log: string): string[] {
  const out = new Set<string>();
  for (const line of log.split("\n")) {
    const m = RED_MARKER.exec(line.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/** GitHub drops log streams now and then; a log that stays unreadable counts as no red files. */
function retry(fn: () => string): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt === 2) console.error(`unreadable log, skipped: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return "";
}

function redOf(run: Run): { job: Job; files: string[] } | null {
  const job = unitJob(run.databaseId);
  if (!job || job.conclusion !== "failure") return null;
  const files = redFiles(retry(() => sh(["gh", "run", "view", String(run.databaseId), "--job", String(job.databaseId), "--log"])));
  return files.length ? { job, files } : null;
}

type Row = { run: Run; file: string; included: boolean; why: string; proof: string | null };

function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string, d: number) => Number(argv[argv.indexOf(name) + 1]) || d;
  const limit = opt("--limit", 100);
  const wanted = opt("--runs", 10);

  const failed = gh<Run[]>(["run", "list", "--workflow", "CI", "--status", "failure", "--limit", String(limit), "--json", "databaseId,event,headSha,headBranch,createdAt,displayTitle"]);
  sh(["git", "fetch", "--quiet", REPO_URL, "+refs/heads/main:refs/remotes/origin/main"]);

  // Reds seen on main: the evidence that a file was red for reasons outside any branch.
  const mainReds: { file: string; run: Run }[] = [];
  const branchReds: { run: Run; files: string[] }[] = [];
  for (const run of failed) {
    const red = redOf(run);
    if (!red) continue;
    if (run.event === "push" && run.headBranch === "main") for (const file of red.files) mainReds.push({ file, run });
    else if (branchReds.length < wanted) branchReds.push({ run, files: red.files });
  }

  const rows: Row[] = [];
  for (const { run, files } of branchReds) {
    let included: (f: string) => { ok: boolean; why: string };
    const dir = mkdtempSync(join(tmpdir(), "touched-measure-"));
    try {
      sh(["git", "fetch", "--quiet", REPO_URL, run.headSha]);
      sh(["git", "worktree", "add", "--detach", "--quiet", dir, run.headSha]);
      const sel = selectForBase("origin/main", dir);
      included = (f) => (sel.kind === "full" ? { ok: true, why: `whole suite (${sel.reason})` } : sel.tests.includes(f) ? { ok: true, why: "in the selection" } : { ok: false, why: `not among ${sel.tests.length} selected tests` });
    } catch (e) {
      included = () => ({ ok: false, why: `cannot replay: ${(e as Error).message.split("\n")[0]}` });
    } finally {
      Bun.spawnSync(["git", "worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
    for (const file of files) {
      const { ok, why } = included(file);
      rows.push({ run, file, included: ok, why, proof: ok ? null : proofFor(run, file, mainReds) });
    }
  }
  report(rows);
  process.exit(rows.some((r) => !r.included && !r.proof) ? 1 : 0);
}

function proofFor(run: Run, file: string, mainReds: { file: string; run: Run }[]): string | null {
  const t = Date.parse(run.createdAt);
  const onMain = mainReds.find((m) => m.file === file && Math.abs(Date.parse(m.run.createdAt) - t) <= WINDOW_MS);
  if (onMain) return `red on main, ${link(onMain.run)}`;
  const siblings = gh<Run[]>(["run", "list", "--workflow", "CI", "--commit", run.headSha, "--json", "databaseId,event,headSha,headBranch,createdAt,displayTitle"]);
  for (const s of siblings) {
    if (s.databaseId === run.databaseId) continue;
    if (unitJob(s.databaseId)?.conclusion === "success") return `green on rerun of the same commit, ${link(s)}`;
  }
  return null;
}

const link = (run: Run) => `https://github.com/${REPO}/actions/runs/${run.databaseId}`;

function report(rows: Row[]) {
  console.log("| run | branch | red file | included | reason | proof |\n|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${link(r.run)} | ${r.run.headBranch} | ${r.file} | ${r.included ? "yes" : "no"} | ${r.why} | ${r.proof ?? (r.included ? "" : "UNPROVEN")} |`);
  }
  const missed = rows.filter((r) => !r.included);
  console.log(`\n${rows.length} red file(s): ${rows.length - missed.length} included, ${missed.length} not (${missed.filter((r) => r.proof).length} proven not from the diff, ${missed.filter((r) => !r.proof).length} unproven)`);
}

if (import.meta.main) main();
