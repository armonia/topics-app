#!/usr/bin/env bun
/**
 * THE QUALITY BAR: exits non-zero when Topics drops under the quality it
 * declares. `qa-gate.sh` runs it as one line.
 *
 * Five measures, each one a fact somebody can check, none a taste:
 *   ci-main      the last finished `CI` run on main is green
 *   e2e-main     every e2e job of that run is green (the spec-flow suite)
 *   bug-issues   open issues labelled `bug` are zero
 *   crash-log    crash-class lines in the tail of the server error log are zero
 *   create-route the one-call "create chat with model, effort and prompt"
 *                route keeps its test green
 *
 * A measure that cannot be read (gh offline, no run found) is RED, never
 * green: unmeasured is not passing. `QUALITY_BAR_OFFLINE=1` skips only the
 * two gh-backed measures, and says so. Thresholds live in THRESHOLDS below and
 * are not environment knobs: lowering one is a reviewed code change.
 *
 * Run: `bun run scripts/quality-bar.ts`   (exit 1 listing each red measure)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const THRESHOLDS = {
  openBugIssues: 0,
  crashLines: 0,
  /** How many lines from the end of the error log count as "now". */
  logTailLines: 5000,
} as const;

export const CRASH_PATTERN = /Uncaught|Unhandled|SQLiteError|FATAL|uncaughtException/;

export interface Verdict { id: string; ok: boolean; detail: string }
export interface CiRun { conclusion: string | null; status: string; databaseId: number }
export interface CiJob { name: string; conclusion: string | null }

export function judgeCiMain(runs: CiRun[] | null): Verdict {
  const id = "ci-main";
  if (!runs) return { id, ok: false, detail: "CI runs not readable" };
  const last = runs.find((r) => r.status === "completed");
  if (!last) return { id, ok: false, detail: "no finished CI run on main" };
  return { id, ok: last.conclusion === "success", detail: `last finished run ${last.databaseId}: ${last.conclusion}` };
}

export function judgeE2eMain(jobs: CiJob[] | null): Verdict {
  const id = "e2e-main";
  if (!jobs) return { id, ok: false, detail: "CI jobs not readable" };
  const e2e = jobs.filter((j) => /^e2e/i.test(j.name));
  if (e2e.length === 0) return { id, ok: false, detail: "no e2e job in the last CI run" };
  const bad = e2e.filter((j) => j.conclusion !== "success");
  return { id, ok: bad.length === 0, detail: bad.length ? `red: ${bad.map((j) => j.name).join(", ")}` : `${e2e.length} e2e jobs green` };
}

export function judgeBugIssues(open: number | null): Verdict {
  const id = "bug-issues";
  if (open === null) return { id, ok: false, detail: "issues not readable" };
  return { id, ok: open <= THRESHOLDS.openBugIssues, detail: `${open} open (max ${THRESHOLDS.openBugIssues})` };
}

export function judgeCrashLog(logText: string | null): Verdict {
  const id = "crash-log";
  if (logText === null) return { id, ok: true, detail: "no server error log on this machine, nothing to count" };
  const tail = logText.split("\n").slice(-THRESHOLDS.logTailLines);
  const n = tail.filter((l) => CRASH_PATTERN.test(l)).length;
  return { id, ok: n <= THRESHOLDS.crashLines, detail: `${n} crash lines in the last ${THRESHOLDS.logTailLines} (max ${THRESHOLDS.crashLines})` };
}

export function judgeCreateRoute(exitCode: number): Verdict {
  return { id: "create-route", ok: exitCode === 0, detail: exitCode === 0 ? "test green" : `test exit ${exitCode}` };
}

function gh(args: string[]): unknown | null {
  const r = Bun.spawnSync(["gh", ...args]);
  if (r.exitCode !== 0) return null;
  try { return JSON.parse(r.stdout.toString()); } catch { return null; }
}

function readLog(): string | null {
  const p = process.env.QUALITY_BAR_ERROR_LOG ?? join(homedir(), ".claude/jarvis/logs/topics-server-error.log");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function collect(): Verdict[] {
  const out: Verdict[] = [];
  if (process.env.QUALITY_BAR_OFFLINE === "1") {
    console.log("quality-bar: QUALITY_BAR_OFFLINE=1, ci-main, e2e-main and bug-issues NOT measured");
  } else {
    const runs = gh(["run", "list", "--branch", "main", "--workflow", "CI", "--limit", "5", "--json", "conclusion,status,databaseId"]) as CiRun[] | null;
    out.push(judgeCiMain(runs));
    const last = runs?.find((r) => r.status === "completed");
    const view = last ? (gh(["run", "view", String(last.databaseId), "--json", "jobs"]) as { jobs: CiJob[] } | null) : null;
    out.push(judgeE2eMain(view?.jobs ?? null));
    const issues = gh(["issue", "list", "--label", "bug", "--state", "open", "--limit", "200", "--json", "number"]) as unknown[] | null;
    out.push(judgeBugIssues(issues ? issues.length : null));
  }
  out.push(judgeCrashLog(readLog()));
  const t = Bun.spawnSync(["bun", "test", "server/routes/topics.create-one-call.test.ts"], { stdout: "ignore", stderr: "ignore" });
  out.push(judgeCreateRoute(t.exitCode ?? 1));
  return out;
}

if (import.meta.main) {
  const verdicts = collect();
  for (const v of verdicts) console.log(`  ${v.ok ? "verde" : "ROSSO"}  ${v.id.padEnd(13)} ${v.detail}`);
  const red = verdicts.filter((v) => !v.ok);
  if (red.length) {
    console.error(`quality-bar: ${red.length} measure(s) under the declared quality`);
    process.exit(1);
  }
}
