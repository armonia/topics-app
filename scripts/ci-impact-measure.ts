#!/usr/bin/env bun
/**
 * scripts/ci-impact-measure.ts - would the reduced pull request tier have caught the reds of main?
 *
 * For every failed push run of ci.yml on main it reads the red e2e specs (job `e2e (N)`) and the red
 * unit files (job `unit`) from the logs, replays `scripts/ci-impact.ts` on the diff of that commit
 * (against its first parent: the main the pull request was merged onto) and says whether each red file
 * is among what the pull request would have run, or the scope would have been `full`. A red file it
 * would have missed is noise when the same file was red on another main run within 24 h, or the run of
 * that commit has a green rerun; with neither proof it is UNPROVEN and the exit code is 1.
 *
 * The unit half of the same question, over the red runs of branches, is test-touched-measure.ts.
 *
 * USAGE (needs `gh` logged in and network)
 *   bun run scripts/ci-impact-measure.ts [--reds 30] [--limit 200]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { impactOf } from "./ci-impact.ts";

const REPO = "armonia/topics-app";
const REPO_URL = `https://github.com/${REPO}.git`;
const WINDOW_MS = 24 * 3600 * 1000;
const UNIT_RED = /^─{3,} (\S+) FALLITO \(exit/; // allow-italian: matches the runner's output
const E2E_RED = /^\s*\d+\) .*?tests\/e2e\/([\w.-]+\.spec\.ts)/;
const STAMP = /^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /;

type Run = { databaseId: number; event: string; headSha: string; headBranch: string; createdAt: string };
type Job = { name: string; conclusion: string | null; databaseId: number };
type Red = { kind: "e2e" | "unit"; file: string };

function sh(cmd: string[], cwd?: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
const gh = <T>(args: string[]): T => JSON.parse(sh(["gh", ...args]));
const link = (run: Run) => `https://github.com/${REPO}/actions/runs/${run.databaseId}`;

function jobLog(run: Run, job: Job): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return sh(["gh", "run", "view", String(run.databaseId), "--job", String(job.databaseId), "--log"]);
    } catch {
      /* GitHub drops log streams now and then */
    }
  }
  return "";
}

/** The red files of a run: the failing specs of `e2e (N)` jobs and the failing files of `unit`. */
function redsOf(run: Run): Red[] {
  const { jobs } = gh<{ jobs: Job[] }>(["run", "view", String(run.databaseId), "--json", "jobs"]);
  const reds = new Map<string, Red>();
  for (const job of jobs.filter((j) => j.conclusion === "failure")) {
    const isE2e = /^e2e( \(\d+\))?$/.test(job.name);
    if (!isE2e && job.name !== "unit") continue;
    for (const line of jobLog(run, job).split("\n")) {
      const m = (isE2e ? E2E_RED : UNIT_RED).exec(line.replace(STAMP, ""));
      if (m) reds.set(`${job.name === "unit" ? "unit" : "e2e"}:${m[1]}`, { kind: isE2e ? "e2e" : "unit", file: m[1]! });
    }
  }
  return [...reds.values()];
}

/** What a pull request with this diff would have run, in the two kinds. */
function replay(run: Run): { e2e: Set<string> | "full"; unit: Set<string> | "full"; why: string } {
  const dir = mkdtempSync(join(tmpdir(), "impact-measure-"));
  try {
    sh(["git", "fetch", "--quiet", REPO_URL, run.headSha]);
    sh(["git", "worktree", "add", "--detach", "--quiet", dir, run.headSha]);
    const base = sh(["git", "rev-parse", `${run.headSha}^1`], dir).trim();
    sh(["git", "fetch", "--quiet", REPO_URL, base], dir);
    const here = process.cwd();
    process.chdir(dir);
    try {
      const impact = impactOf(base);
      return {
        e2e: impact.e2e.kind === "full" ? "full" : new Set(impact.e2e.files),
        unit: impact.unit.kind === "full" ? "full" : new Set(impact.unit.tests),
        why: impact.e2e.reason,
      };
    } finally {
      process.chdir(here);
    }
  } finally {
    Bun.spawnSync(["git", "worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const opt = (name: string, d: number) => Number(argv[argv.indexOf(name) + 1]) || d;
const wanted = opt("--reds", 30);
const limit = opt("--limit", 200);

const failed = gh<Run[]>(["run", "list", "--workflow", "CI", "--branch", "main", "--event", "push", "--status", "failure", "--limit", String(limit), "--json", "databaseId,event,headSha,headBranch,createdAt"]);
const reds = new Map<number, Red[]>();
for (const run of failed) {
  if (reds.size >= wanted) break;
  const r = redsOf(run);
  if (r.length) reds.set(run.databaseId, r);
}
const byId = new Map(failed.map((r) => [r.databaseId, r]));

function noise(run: Run, red: Red): string | null {
  const t = Date.parse(run.createdAt);
  for (const [id, other] of reds) {
    const o = byId.get(id)!;
    if (id !== run.databaseId && Math.abs(Date.parse(o.createdAt) - t) <= WINDOW_MS && other.some((x) => x.file === red.file)) return `red on another main run, ${link(o)}`;
  }
  const same = gh<Run[]>(["run", "list", "--workflow", "CI", "--commit", run.headSha, "--json", "databaseId,event,headSha,headBranch,createdAt,conclusion"]);
  const green = same.find((s) => s.databaseId !== run.databaseId && (s as Run & { conclusion?: string }).conclusion === "success");
  return green ? `green on a rerun of the same commit, ${link(green)}` : null;
}

let caught = 0;
let full = 0;
let flaky = 0;
let lost = 0;
console.log("| run | red file | kind | result |\n|---|---|---|---|");
for (const [id, list] of reds) {
  const run = byId.get(id)!;
  let r: ReturnType<typeof replay> | null = null;
  try {
    r = replay(run);
  } catch (e) {
    console.log(`| ${link(run)} | - | - | cannot replay: ${(e as Error).message.split("\n")[0]} |`);
  }
  for (const red of list) {
    const scope = r?.[red.kind];
    let verdict: string;
    if (scope === "full") {
      full++;
      verdict = `full tier (${r!.why})`;
    } else if (scope?.has(red.file)) {
      caught++;
      verdict = "in the reduced plan";
    } else {
      const proof = noise(run, red);
      if (proof) {
        flaky++;
        verdict = `noise: ${proof}`;
      } else {
        lost++;
        verdict = "UNPROVEN (missed)";
      }
    }
    console.log(`| ${link(run)} | ${red.file} | ${red.kind} | ${verdict} |`);
  }
}
console.log(`\n${reds.size} red main run(s): ${caught} red files caught by the reduced plan, ${full} by the full fallback, ${flaky} noise, ${lost} UNPROVEN`);
process.exit(lost ? 1 : 0);
