#!/usr/bin/env bun
/**
 * THE "SOLIDO" INDEX: how many of the possible bugs the tests actually catch.
 *
 * Line coverage says a line ran, not that a bug in it would turn anything red.
 * The mutation score does: Stryker breaks the code on purpose (stryker.config.mjs)
 * and counts how many of those breaks the suite catches.
 * Score = (killed + timeout) / (killed + timeout + survived + no coverage).
 * Mutants that do not compile or crash on their own count neither way: they
 * prove nothing.
 *
 * WHY A RATCHET. Like `check:bloat` and `check:any-budget`: start from where we
 * are, and each module's number can only go up. A module that drops means a
 * weakened test or a new branch without one, and it is red. One that rises
 * prints the line to lock it in (`--update-baseline`), which never lowers
 * anything: lowering a bar is a hand edit of the baseline, visible in review.
 *
 * Even 100% is not "certain": it proves the tests catch every mutation Stryker
 * knows how to make, not that the intended behaviour is the right one. That is
 * what the specs are for (`check:spec-coverage`).
 *
 * Usage:
 *   bun run check:mutation                    compare reports/mutation/mutation.json with the baseline
 *   bun run check:mutation --update-baseline  lock in the scores that rose (never the ones that fell)
 *   bun run check:mutation --report <file>    read another report
 * The report comes from `bun run mutation` (heavy: in CI it runs in the Mutation workflow).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CRITICAL } from "./mutation-critical.ts";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_FILE = resolve(ROOT, "scripts/mutation-baseline.json");
const DEFAULT_REPORT = resolve(ROOT, "reports/mutation/mutation.json");

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

export type FileScore = { detected: number; undetected: number; score: number };
type Report = { files: Record<string, { mutants: { status: string }[] }> };

/** Each file's score in the report, as a percentage with one decimal. */
export function scoresOf(report: Report): Record<string, FileScore> {
  const out: Record<string, FileScore> = {};
  for (const [file, { mutants }] of Object.entries(report.files ?? {})) {
    const detected = mutants.filter((m) => DETECTED.has(m.status)).length;
    const undetected = mutants.filter((m) => UNDETECTED.has(m.status)).length;
    const valid = detected + undetected;
    out[normalize(file)] = { detected, undetected, score: valid ? round1((detected / valid) * 100) : 100 };
  }
  return out;
}

/** The index of the whole scope: caught mutants over valid ones, not the mean of the files. */
export function overall(scores: Record<string, FileScore>): number {
  const d = Object.values(scores).reduce((s, f) => s + f.detected, 0);
  const u = Object.values(scores).reduce((s, f) => s + f.undetected, 0);
  return d + u ? round1((d / (d + u)) * 100) : 100;
}

export type Verdict = { file: string; ok: boolean; line: string };

/**
 * Every critical module against its baseline. Red if it is missing from the report
 * (unmeasured is not passing), missing from the baseline (a module enters with its
 * number), or if its score fell.
 */
export function judge(
  critical: string[],
  scores: Record<string, FileScore>,
  baseline: Record<string, number>,
): Verdict[] {
  return critical.map((file) => {
    const now = scores[file];
    const base = baseline[file];
    if (!now) return { file, ok: false, line: `${file}: not in the mutation report, so not measured` };
    if (base === undefined)
      return { file, ok: false, line: `${file}: ${now.score}% but no baseline. Record it with --update-baseline` };
    if (now.score < base)
      return { file, ok: false, line: `${file}: ${now.score}% < baseline ${base}% (${now.undetected} mutants survive)` };
    const up = now.score > base ? ` (up from ${base}%: run --update-baseline to lock it in)` : "";
    return { file, ok: true, line: `${file}: ${now.score}%${up}` };
  });
}

/** The new baseline: for each module the max of the old one and today's score. */
export function raised(
  critical: string[],
  scores: Record<string, FileScore>,
  baseline: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const file of critical) {
    const now = scores[file]?.score;
    const base = baseline[file];
    if (now === undefined && base === undefined) continue;
    next[file] = Math.max(now ?? -Infinity, base ?? -Infinity);
  }
  return next;
}

function normalize(p: string): string {
  const rel = p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
  return rel.replace(/\\/g, "/");
}

function round1(n: number): number {
  return Math.floor(n * 10) / 10;
}

/**
 * The critical sources the workflow's `pull_request.paths` filter does NOT name.
 * Without this, a module added to CRITICAL enters the nightly run but a PR that
 * weakens it never starts the job: you find out the next morning, on a red main.
 */
export function missingFromPaths(critical: string[], workflowText: string): string[] {
  const globs = [...workflowText.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
  const matches = (file: string, glob: string) =>
    new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(file);
  return critical.filter((f) => !globs.some((g) => matches(f, g)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reportPath = args.includes("--report") ? resolve(args[args.indexOf("--report") + 1]) : DEFAULT_REPORT;
  if (!existsSync(reportPath)) {
    console.error(`check:mutation: no report at ${reportPath}. Run \`bun run mutation\` first.`);
    process.exit(1);
  }
  const scores = scoresOf(JSON.parse(readFileSync(reportPath, "utf8")));
  const baseline: Record<string, number> = existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")).scores
    : {};
  const critical = CRITICAL.map((m) => m.source);

  if (args.includes("--update-baseline")) {
    const next = raised(critical, scores, baseline);
    writeFileSync(BASELINE_FILE, JSON.stringify({ $schema: "mutation-baseline-v1", scores: next }, null, 2) + "\n");
    console.log(`check:mutation: baseline written, ${Object.keys(next).length} modules, never lowered`);
    process.exit(0);
  }

  const verdicts = judge(critical, scores, baseline);
  for (const v of verdicts) console.log(`  ${v.ok ? "verde" : "ROSSO"}  ${v.line}`);
  const inScope = Object.fromEntries(critical.filter((f) => scores[f]).map((f) => [f, scores[f]]));
  console.log(`check:mutation: indice solido ${overall(inScope)}% su ${critical.length} moduli critici`);
  if (verdicts.some((v) => !v.ok)) process.exit(1);
}
