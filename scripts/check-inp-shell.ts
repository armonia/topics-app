#!/usr/bin/env bun
/**
 * THE INTERACTION RESPONSIVENESS GATE.
 *
 * Prints the p95 of how long the app takes to answer an interaction, judged
 * against a budget recorded at the first measurement.
 *
 *   bun run check:inp-shell                              measure (engine), then judge
 *   bun run check:inp-shell -- --no-run                   judge the last engine file again
 *   bun run check:inp-shell -- --from FILE.json           judge a measurement already taken
 *   bun run check:inp-shell -- --source=shell             judge the desktop shell log
 *   bun run check:inp-shell -- --source=shell --update-baseline   record the shell budget
 *
 * TWO SOURCES, ONE JUDGE. The engine source is `tests/e2e/inp-shell.spec.ts`,
 * which drives frequent interactions on WebKit and writes
 * `test-results/inp-shell.json`; the judgement is here. The shell source is
 * the production desktop shell, which reports one cumulative histogram per
 * page load into the server log (see `parseSummaryLines`). Both end up as one
 * p95 against one recorded budget.
 *
 * THREE EXITS, like the sibling gates:
 *   0  measured, and the p95 is within budget
 *   1  MEASURED and over budget, or the command line was wrong
 *   2  NOT measured: the baseline was never recorded, the file is missing or
 *      older than the window, the run reports supported:false, too few
 *      interactions were counted, or the log holds no shell summary. A gate
 *      that confuses those with a regression stops being believed, which is
 *      worse than no gate.
 *
 * Precedence inside `judge`: a baseline that was never recorded answers 2
 * before anything else. Past that, a measured overrun beats every abstention:
 * when the file holds a p95 above budget, the gate is red even when the same
 * file is stale, unsupported, or short on interactions.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  INTERACTION_BUCKET_EDGES,
  interactionPercentile,
  mergeInteractionHistograms,
} from "../shared/interaction-histogram";

const REPO_ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/inp-shell-baseline.json");
const ENGINE_TEST = "tests/e2e/inp-shell.spec.ts";
const DEFAULT_ENGINE_OUT = join(REPO_ROOT, "test-results/inp-shell.json");
const ENGINE_MINIMUM = 20;
const SHELL_MINIMUM = 200;
/** The INP metric calls 200 ms and below good: the budget never passes it. */
const GOOD_CEILING_MS = 200;
/** A budget below this would accuse code that answers in one frame. */
const BUDGET_FLOOR_MS = 48;
const STALE_HOURS_DEFAULT = 24;
const SHELL_DAYS_DEFAULT = 7;
const MS_PER_DAY = 86_400_000;

/** The two places a p95 can come from. */
export type InteractionSource = "engine" | "shell";

/** One recorded budget, per source, in `scripts/inp-shell-baseline.json`. */
export interface InteractionBaselineEntry {
  recorded: boolean;
  measuredOn: string | null;
  p95Ms: number | null;
  budgetMs: number | null;
}

export interface InteractionBaselineFile {
  $schema: string;
  why: string;
  rule: string;
  sources: Record<InteractionSource, InteractionBaselineEntry>;
}

/** One p95 with the evidence around it, whatever the source. */
export interface InteractionReading {
  source: InteractionSource;
  interactions: number;
  slow: number;
  p95Ms: number | null;
  worstMs: number;
  supported: boolean;
  stale: boolean;
  found: boolean;
}

/** 0 green, 1 over budget, 2 not measured. See the header. */
export type InteractionExit = 0 | 1 | 2;

export interface InteractionOutcome {
  code: InteractionExit;
  /** The measured-against-budget rows, always printed. */
  rows: string[];
  /** What went over. Empty unless the code is 1. */
  over: string[];
  /** Why the measurement is worth nothing. Empty unless the code is 2. */
  blockers: string[];
  /** True when the baseline has never been recorded for this source. */
  unrecorded: boolean;
}

/** One cumulative report from one page load of the desktop shell. */
export interface InteractionSummary {
  clientId: string;
  pageLoad: string;
  shell: string;
  total: number;
  slow: number;
  worst: number;
  histogram: number[];
  timeMs: number;
}

/** Several page loads pooled into one p95. */
export interface PooledInteractions {
  total: number;
  slow: number;
  worst: number;
  histogram: number[];
  p95Ms: number | null;
}

/**
 * The blockers of a reading, pure: every reason the number cannot be judged.
 * Empty means the measurement speaks about the product.
 */
export function measureBlockers(reading: InteractionReading): string[] {
  const blockers: string[] = [];
  if (!reading.found) {
    blockers.push(
      "no measurement was found: with nothing counted there is nothing to judge",
    );
  }
  if (reading.stale) {
    blockers.push(
      "the measurement is older than the accepted window: it speaks about " +
        "the code as it was, not as it is",
    );
  }
  if (!reading.supported) {
    blockers.push(
      "the run reports supported:false: the bench could not drive the " +
        "interactions it claims to judge",
    );
  }
  const minimum = reading.source === "engine" ? ENGINE_MINIMUM : SHELL_MINIMUM;
  if (reading.interactions < minimum) {
    blockers.push(
      `only ${reading.interactions} interactions were counted, below the minimum ` +
        `of ${minimum}: too few for a percentile to mean anything`,
    );
  }
  if (typeof reading.p95Ms !== "number" || !Number.isFinite(reading.p95Ms)) {
    blockers.push(
      "the measurement carries no p95: without it there is no number to judge",
    );
  }
  return blockers;
}

/**
 * The judgement, pure: one reading and one recorded budget in, one outcome out.
 *
 * Pure so it is falsifiable without a browser: `scripts/check-inp-shell.test.ts`
 * feeds it synthetic readings, including the ones that MUST come out red.
 */
export function judge(
  reading: InteractionReading,
  baseline: InteractionBaselineEntry,
): InteractionOutcome {
  const rows: string[] = [];
  const over: string[] = [];
  const budget = baseline.budgetMs;
  const measured = reading.p95Ms;
  const budgetLabel = typeof budget === "number" ? `${budget} ms` : "none recorded";
  rows.push(`source        ${reading.source}`);
  rows.push(`interactions  ${reading.interactions}`);
  rows.push(`slow          ${reading.slow}`);
  rows.push(
    `p95           ${typeof measured === "number" ? `${measured} ms` : "not measured"}` +
      `   budget ${budgetLabel}`,
  );
  rows.push(`worst         ${reading.worstMs} ms`);

  const neverRecorded = baseline.recorded !== true || typeof budget !== "number";
  if (neverRecorded) return { code: 2, rows, over, blockers: [], unrecorded: true };

  // A MEASURED overrun beats an abstention: when the file holds a p95 above
  // budget the gate is red, whatever else is wrong with the same file.
  if (typeof measured === "number" && measured > (budget as number)) {
    over.push(`p95 ${measured}ms > budget ${(budget as number)}ms`);
    return { code: 1, rows, over, blockers: [], unrecorded: false };
  }

  const blockers = measureBlockers(reading);
  if (blockers.length > 0) return { code: 2, rows, over, blockers, unrecorded: false };
  return { code: 0, rows, over, blockers, unrecorded: false };
}

/**
 * One line of the server log that carries a shell histogram. The server prints
 * `[client-trace] <time> <clientId> pane-attach <event> <fields>` (see
 * `server/routes/client-trace.ts`); the shell sends the event `inp-summary`
 * with its cumulative totals as fields. Fields cut at 600 chars are not valid
 * JSON and are skipped, never a crash.
 */
const SUMMARY_LINE = /^\[client-trace\] (\S+) (\S+) pane-attach inp-summary (.*)$/;

function isCountList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === INTERACTION_BUCKET_EDGES.length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/**
 * The shell summaries in log text, pure. Each page load reports CUMULATIVE
 * totals several times, so only the LAST line per (clientId, pageLoad) is
 * kept. Lines outside the day window, lines from another shell, and lines
 * whose JSON was cut are skipped.
 */
export function parseSummaryLines(text: string, sinceMs: number): InteractionSummary[] {
  const latest = new Map<string, InteractionSummary>();
  const order: string[] = [];
  for (const line of text.split("\n")) {
    const match = SUMMARY_LINE.exec(line);
    if (!match) continue;
    const timeMs = Date.parse(match[1] as string);
    if (!Number.isFinite(timeMs) || timeMs < sinceMs) continue;
    const clientId = match[2] as string;
    let fields: {
      shell?: unknown;
      pl?: unknown;
      n?: unknown;
      s?: unknown;
      w?: unknown;
      h?: unknown;
    };
    try {
      fields = JSON.parse(match[3] as string) as typeof fields;
    } catch {
      continue;
    }
    if (fields === null || typeof fields !== "object") continue;
    if (fields.shell !== "tauri") continue;
    if (typeof fields.pl !== "string") continue;
    if (typeof fields.n !== "number" || !Number.isFinite(fields.n)) continue;
    if (typeof fields.s !== "number" || !Number.isFinite(fields.s)) continue;
    if (typeof fields.w !== "number" || !Number.isFinite(fields.w)) continue;
    if (!isCountList(fields.h)) continue;
    const key = `${clientId} ${fields.pl}`;
    if (!latest.has(key)) order.push(key);
    latest.set(key, {
      clientId,
      pageLoad: fields.pl,
      shell: "tauri",
      total: fields.n,
      slow: fields.s,
      worst: fields.w,
      histogram: [...(fields.h as number[])],
      timeMs,
    });
  }
  return order.map((key) => latest.get(key) as InteractionSummary);
}

/**
 * Several page loads pooled into one p95, pure: totals add up, the histograms
 * merge bucket by bucket, and the quantile is read back from the merged
 * histogram over the merged total.
 */
export function poolReports(reports: readonly InteractionSummary[]): PooledInteractions {
  let total = 0;
  let slow = 0;
  let worst = 0;
  const histograms: number[][] = [];
  for (const summary of reports) {
    total += summary.total;
    slow += summary.slow;
    if (summary.worst > worst) worst = summary.worst;
    histograms.push(summary.histogram);
  }
  const histogram = mergeInteractionHistograms(histograms);
  return { total, slow, worst, histogram, p95Ms: interactionPercentile(histogram, total, 0.95) };
}

/** Up to the next multiple of 8: browsers round these durations to 8 ms. */
export function roundUpTo8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

/**
 * The budget recorded from the first real measurement: four times the
 * measured p95 rounded up to 8, never below 48 and never above 200.
 */
export function budgetFromP95(measuredP95: number): number {
  return Math.min(GOOD_CEILING_MS, Math.max(BUDGET_FLOOR_MS, roundUpTo8(4 * measuredP95)));
}

/**
 * Why `--update-baseline` refuses to record, or null when it may record.
 * Above 200 the gate is born red on purpose: the first measurement already
 * found a real problem, and writing a budget above the good ceiling would
 * bless it as normal.
 */
export function baselineRefusedReason(measuredP95: number | null): string | null {
  if (typeof measuredP95 !== "number" || !Number.isFinite(measuredP95)) {
    return "there is no measured p95 to record";
  }
  if (measuredP95 > GOOD_CEILING_MS) {
    return (
      `the measured p95 of ${measuredP95} ms is already above the good ceiling ` +
        `of ${GOOD_CEILING_MS} ms: the gate is born red on purpose, because it ` +
        `found a real problem, and no budget is recorded`
    );
  }
  return null;
}

interface EngineFile {
  supported?: unknown;
  interactions?: unknown;
  slow?: unknown;
  p95Ms?: unknown;
  worstMs?: unknown;
  histogram?: unknown;
}

function readEngineFile(path: string): { reading: InteractionReading; shaped: boolean; note: string } {
  const empty: InteractionReading = {
    source: "engine",
    interactions: 0,
    slow: 0,
    p95Ms: null,
    worstMs: 0,
    supported: true,
    stale: false,
    found: false,
  };
  if (!existsSync(path)) {
    return { reading: empty, shaped: false, note: `no measurement at ${path}` };
  }
  let parsed: EngineFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as EngineFile;
  } catch {
    return { reading: empty, shaped: false, note: `${path} is not valid JSON` };
  }
  const raw = parsed as unknown as Record<string, unknown>;
  const histogram = raw["histogram"];
  const supported = raw["supported"];
  if (
    typeof raw["interactions"] !== "number" ||
    typeof raw["slow"] !== "number" ||
    typeof raw["worstMs"] !== "number" ||
    (typeof raw["p95Ms"] !== "number" && raw["p95Ms"] !== null) ||
    !Array.isArray(histogram) ||
    typeof supported !== "boolean"
  ) {
    return {
      reading: empty,
      shaped: false,
      note:
        `${path} does not have the shape of a measurement ` +
        `(supported, interactions, slow, p95Ms, worstMs, histogram are required)`,
    };
  }
  const p95 = raw["p95Ms"];
  return {
    reading: {
      source: "engine",
      interactions: raw["interactions"] as number,
      slow: raw["slow"] as number,
      p95Ms: typeof p95 === "number" ? p95 : null,
      worstMs: raw["worstMs"] as number,
      supported: supported as boolean,
      stale: false,
      found: true,
    },
    shaped: true,
    note: "",
  };
}

function main(): number {
  const argv = process.argv.slice(2);
  let source: InteractionSource = "engine";
  let noRun = false;
  let from: string | undefined;
  const logPaths: string[] = [];
  let days = SHELL_DAYS_DEFAULT;
  let maxAgeHours = STALE_HOURS_DEFAULT;
  let update = false;

  const takeValue = (flag: string, index: number): string | undefined => {
    const token = argv[index] as string;
    const glued = `--${flag}=`;
    if (token.startsWith(glued)) return token.slice(glued.length);
    if (token === `--${flag}`) return argv[index + 1];
    return undefined;
  };
  const takesArg = (flag: string, index: number): boolean => {
    const token = argv[index] as string;
    return token === `--${flag}` || token.startsWith(`--${flag}=`);
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (takesArg("source", index)) {
      const value = takeValue("source", index);
      if (value !== "engine" && value !== "shell") {
        console.error(`check:inp-shell - --source wants engine or shell, got ${JSON.stringify(value)}.`);
        return 1;
      }
      source = value;
      if (!token.includes("=")) index++;
    } else if (token === "--no-run") {
      noRun = true;
    } else if (takesArg("from", index)) {
      const value = takeValue("from", index);
      if (!value) {
        console.error("check:inp-shell - --from wants a path.");
        return 1;
      }
      from = value;
      if (!token.includes("=")) index++;
    } else if (takesArg("log", index)) {
      const value = takeValue("log", index);
      if (!value) {
        console.error("check:inp-shell - --log wants a path.");
        return 1;
      }
      logPaths.push(value);
      if (!token.includes("=")) index++;
    } else if (takesArg("days", index)) {
      const value = takeValue("days", index);
      const count = Number(value);
      if (!Number.isFinite(count) || count < 0) {
        console.error(`check:inp-shell - --days wants a number of days, got ${JSON.stringify(value)}.`);
        return 1;
      }
      days = count;
      if (!token.includes("=")) index++;
    } else if (takesArg("max-age-hours", index)) {
      const value = takeValue("max-age-hours", index);
      const count = Number(value);
      if (!Number.isFinite(count) || count <= 0) {
        console.error(`check:inp-shell - --max-age-hours wants a positive number, got ${JSON.stringify(value)}.`);
        return 1;
      }
      maxAgeHours = count;
      if (!token.includes("=")) index++;
    } else if (token === "--update-baseline") {
      update = true;
    } else {
      console.error(`check:inp-shell - unknown argument ${JSON.stringify(token)}.`);
      return 1;
    }
  }
  if (source === "shell" && from !== undefined) {
    console.error("check:inp-shell - --from judges an engine file; it has no meaning with --source=shell.");
    return 1;
  }

  let baseline: InteractionBaselineFile;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as InteractionBaselineFile;
  } catch {
    console.error(`! No baseline at ${BASELINE_PATH}: nothing was ever recorded, so there is nothing to judge.`);
    return 2;
  }
  const entry = baseline.sources[source];
  if (!entry) {
    console.error(`! The baseline at ${BASELINE_PATH} has no entry for ${source}: nothing to judge.`);
    return 2;
  }

  // The never-recorded baseline is answered BEFORE measuring, not after.
  // Measuring first would spend minutes of bench time to reach a verdict that
  // is already known. `--update-baseline` still has to measure, because
  // measuring is how the number gets recorded.
  if (!from && !update && entry.recorded !== true) {
    console.error(
      `! BASELINE NEVER RECORDED for ${source}, so there is nothing to judge.\n` +
        `  Record it on an idle machine and commit the diff:\n\n` +
        `      bun run check:inp-shell -- --source=${source} --update-baseline\n`,
    );
    return 2;
  }

  let reading: InteractionReading;
  if (source === "engine") {
    // `resolve` and not `join`: with an absolute path `join` would glue it
    // onto the repo root and the file would "not exist" for a fake reason.
    const outPath = from ? resolve(REPO_ROOT, from) : DEFAULT_ENGINE_OUT;
    if (!from && !noRun) {
      console.log(`> measuring ${ENGINE_TEST} (webkit bench)\n`);
      const run = spawnSync("npx", ["playwright", "test", ENGINE_TEST, "--project=webkit", "--reporter=dot"], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (run.status !== 0) {
        console.error(
          `\ncheck:inp-shell - the measurement did not complete (playwright exit ${run.status}).\n` +
            "Nothing was measured, so nothing is being judged. This is NOT a pass and it\n" +
            "is NOT a regression either: the gate abstains (exit 2). The app itself is\n" +
            "judged by the E2E job, which runs this same spec.",
        );
        return 2;
      }
    }
    const loaded = readEngineFile(outPath);
    if (!loaded.shaped) {
      console.error(`check:inp-shell - ${loaded.note}. No number, no verdict: the gate abstains (exit 2).`);
      if (update) {
        console.error("! I do not record a measurement that is worth nothing:\n  - " + loaded.note);
        return 2;
      }
      const early = judge(loaded.reading, entry);
      for (const row of early.rows) console.log(row);
      console.error(`\n! MEASUREMENT UNUSABLE:\n  - ${loaded.note}`);
      return 2;
    }
    reading = loaded.reading;
    if (!from) {
      try {
        const ageMs = Date.now() - statSync(outPath).mtimeMs;
        reading.stale = ageMs > maxAgeHours * 3_600_000;
      } catch {
        reading.stale = false;
      }
    }
  } else {
    const home = homedir();
    const wanted =
      logPaths.length > 0
        ? logPaths
        : [join(home, ".claude/jarvis/logs/topics-server.log"), join(home, ".claude/jarvis/logs/topics-server-error.log")];
    const parts: string[] = [];
    const skipped: string[] = [];
    for (const raw of wanted) {
      const path = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
      if (!existsSync(path)) {
        skipped.push(path);
        continue;
      }
      parts.push(readFileSync(path, "utf8"));
    }
    const sinceMs = Date.now() - days * MS_PER_DAY;
    const reports = parseSummaryLines(parts.join("\n"), sinceMs);
    if (reports.length === 0) {
      console.error(
        "check:inp-shell - no tauri summary line in the server logs " +
          `(read ${parts.length}, skipped ${skipped.length} missing). ` +
          "No number, no verdict: the gate abstains (exit 2).",
      );
      if (update) {
        console.error("! I do not record a measurement that is worth nothing.");
        return 2;
      }
      return 2;
    }
    const pooled = poolReports(reports);
    reading = {
      source: "shell",
      interactions: pooled.total,
      slow: pooled.slow,
      p95Ms: pooled.p95Ms,
      worstMs: pooled.worst,
      supported: true,
      stale: false,
      found: true,
    };
    console.log(`logs           ${parts.length} read, ${skipped.length} missing, ${reports.length} page loads in the window`);
  }

  const outcome = judge(reading, entry);
  for (const row of outcome.rows) console.log(row);

  if (update) {
    const blockers = measureBlockers(reading);
    if (blockers.length > 0) {
      console.error(`\n! I do not record a measurement that is worth nothing:\n  - ${blockers.join("\n  - ")}`);
      return 2;
    }
    const measuredP95 = reading.p95Ms as number;
    const refusal = baselineRefusedReason(measuredP95);
    if (refusal !== null) {
      console.error(`\n! ${refusal}.`);
      return 1;
    }
    const budget = budgetFromP95(measuredP95);
    let updateExit: InteractionExit = 0;
    if (entry.recorded === true && typeof entry.budgetMs === "number" && measuredP95 > entry.budgetMs) {
      console.error(
        `\n! Recording the baseline ON A WORSENED MEASUREMENT: p95 ${measuredP95}ms > budget ${entry.budgetMs}ms.\n` +
          `  The exit stays 1: if the cost is deliberate, the commit has to say so.`,
      );
      updateExit = 1;
    }
    const next = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as InteractionBaselineFile;
    next.sources[source] = {
      recorded: true,
      measuredOn: new Date().toISOString().slice(0, 10),
      p95Ms: measuredP95,
      budgetMs: budget,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\n> Baseline recorded in ${BASELINE_PATH}: p95 ${measuredP95} ms, budget ${budget} ms.`);
    return updateExit;
  }

  if (outcome.blockers.length > 0) {
    console.error(`\n! MEASUREMENT UNUSABLE:\n  - ${outcome.blockers.join("\n  - ")}`);
    console.error("\nNo verdict on interaction responsiveness: the measurement does not speak about the product.");
    return 2;
  }

  if (outcome.unrecorded) {
    console.error(
      `\n! BASELINE NEVER RECORDED for ${source}.\n` +
        `  Record it on an idle machine and commit the diff:\n\n` +
        `      bun run check:inp-shell -- --source=${source} --update-baseline\n\n` +
        `  Exit 2, not 0: a budget that has never seen a real number cannot tell "fine"\n` +
        `  from "the bench measured nothing".`,
    );
    return 2;
  }

  if (outcome.code === 1) {
    console.error(`\n! Interactions got slower:\n  - ${outcome.over.join("\n  - ")}`);
    return 1;
  }

  console.log("\n> Interactions inside the budget.");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
