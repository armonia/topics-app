#!/usr/bin/env bun
/**
 * CLICK -> INK, as a gate.
 *
 * Prints how many milliseconds the app takes to PAINT the answer to the three
 * most frequent gestures, and exits non-zero when any of them is over budget.
 * It replaces the adjectives ("fast", "instant", "fluid") that cannot fail, and
 * therefore never finish, with a command that can.
 *
 *   card    click a board card    -> its title is readable in the task drawer
 *   tab     click another tab     -> that chat's own message is readable
 *   send    press Enter to send   -> the sent message is readable in the list
 *
 * WHERE EACH PIECE LIVES.
 *   the probe       tests/e2e/helpers/ink.ts        (event.timeStamp -> painted frame)
 *   the measurement tests/e2e/ink-latency.spec.ts   (drives the app, writes the JSON)
 *   the threshold   tests/e2e/ink-budget.json       (ONE copy, this is its only reader)
 *   the verdict     here
 *
 * The spec deliberately does not assert the budget: one number judged in two
 * places is how a budget ends up with two values.
 *
 * THREE OUTCOMES, because "I did not measure" is not a verdict.
 *   0  measured, every gesture within budget
 *   1  MEASURED and over budget, or the command was invoked wrong
 *   2  NOT measured: the probe never produced a number, so there is nothing to
 *      judge. Its siblings (route-latency, scroll-fluidity, drag, growth) all
 *      have this exit already; this gate did not, so a run where Playwright
 *      never got to the measurement was reported as a performance regression.
 *      Measured on run 33027396174 (2026-08-27): the job `check` went red on
 *      "Click-to-ink budget" with no ink number anywhere in the log.
 *
 * Exit 2 does NOT hide a broken app: the very same spec runs inside the E2E
 * shards, in their own job, where a failure to drive the app is a real red.
 * What is silenced here is only the second verdict on the same fact.
 *
 * Usage
 *   bun run check:ink                  measure, then judge
 *   bun run check:ink --stall 300      make the app really slow, then judge
 *                                      (the falsification lever: proves the gate
 *                                      goes red for the reason it exists)
 *   bun run check:ink --no-run         judge the last measurement again
 *
 * The measurement runs against the isolated E2E server the Playwright
 * globalSetup starts, so it needs a built client bundle exactly like the rest of
 * the suite: `bun run build:client`, or point TOPICS_E2E_BUNDLE_DIR at a bundle
 * built elsewhere. E2E_PORT is honoured when set.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SPEC = "tests/e2e/ink-latency.spec.ts";
const BUDGET_PATH = join(REPO_ROOT, "tests/e2e/ink-budget.json");
const RESULT_PATH = join(REPO_ROOT, "test-results/ink-latency.json");

/** The gestures, in the order a human reads them, with what "the answer" means. */
const GESTURES: Array<{ key: string; label: string; answer: string }> = [
  { key: "card", label: "open a card", answer: "the card's title in the drawer" },
  { key: "tab", label: "switch tab", answer: "the other chat's message" },
  { key: "send", label: "send a message", answer: "the sent message in the list" },
];

/** Over budget, or invoked wrong: the run stops. */
const OVER_BUDGET = 1;
/** Nothing was measured: the gate abstains, and says so out loud. */
const NOT_MEASURED = 2;

interface Budget {
  budget: { medianMs: number; maxMs: number };
}

interface Measured {
  samples: number[];
  frames: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

interface Result {
  measuredAt: string;
  samplesPerGesture: number;
  stallMs: number;
  gestures: Record<string, Measured>;
}

function main(): number {
  const args = process.argv.slice(2);
  const noRun = args.includes("--no-run");
  const stallAt = args.indexOf("--stall");
  const stallMs = stallAt >= 0 ? Number(args[stallAt + 1]) : 0;
  if (stallAt >= 0 && (!Number.isFinite(stallMs) || stallMs <= 0)) {
    console.error("check:ink — --stall wants a positive number of milliseconds");
    return OVER_BUDGET;
  }

  if (!noRun) {
    const env = { ...process.env };
    if (stallMs > 0) env.INK_STALL_MS = String(stallMs);
    console.log(
      stallMs > 0
        ? `Measuring with a ${stallMs}ms main-thread stall on every gesture…`
        : "Measuring…",
    );
    const run = spawnSync("npx", ["playwright", "test", SPEC, "--reporter=dot"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (run.status !== 0) {
      console.error(
        `\ncheck:ink — the measurement did not complete (playwright exit ${run.status}).\n` +
          "Nothing was measured, so nothing is being judged. This is NOT a pass and it\n" +
          "is NOT a regression either: the gate abstains (exit 2). The app itself is\n" +
          "judged by the E2E job, which runs this same spec.",
      );
      return NOT_MEASURED;
    }
  }

  if (!existsSync(RESULT_PATH)) {
    console.error(
      `check:ink — no measurement at ${RESULT_PATH}. Run without --no-run.\n` +
        "No number, no verdict: the gate abstains (exit 2).",
    );
    return NOT_MEASURED;
  }
  const budget = (JSON.parse(readFileSync(BUDGET_PATH, "utf8")) as Budget).budget;
  const result = JSON.parse(readFileSync(RESULT_PATH, "utf8")) as Result;

  const rows: string[] = [];
  const failures: string[] = [];
  const missing: string[] = [];
  for (const gesture of GESTURES) {
    const measured = result.gestures[gesture.key];
    if (!measured) {
      missing.push(gesture.label);
      rows.push(pad(gesture.label, 18) + "  -  not measured");
      continue;
    }
    const overMedian = measured.medianMs > budget.medianMs;
    const overMax = measured.maxMs > budget.maxMs;
    const mark = overMedian || overMax ? "FAIL" : "ok  ";
    rows.push(
      `${pad(gesture.label, 18)}${pad(`${measured.medianMs} ms`, 12)}` +
        `${pad(`max ${measured.maxMs} ms`, 16)}${mark}   → ${gesture.answer}`,
    );
    if (overMedian) {
      failures.push(
        `${gesture.label}: ${measured.medianMs}ms median, budget ${budget.medianMs}ms ` +
          `(samples ${measured.samples.join(", ")})`,
      );
    }
    if (overMax) {
      failures.push(
        `${gesture.label}: one sample at ${measured.maxMs}ms, ceiling ${budget.maxMs}ms ` +
          `(samples ${measured.samples.join(", ")})`,
      );
    }
  }

  console.log("\nCLICK → INK: milliseconds from the gesture to the painted answer");
  console.log(
    `${result.samplesPerGesture} samples each · measured ${result.measuredAt}` +
      (result.stallMs > 0 ? ` · WITH a ${result.stallMs}ms injected stall` : ""),
  );
  console.log(`budget: median ≤ ${budget.medianMs} ms, no sample > ${budget.maxMs} ms\n`);
  for (const row of rows) console.log("  " + row);

  // A MEASURED overrun beats an abstention: if even one gesture is genuinely
  // over budget the gate is red, whatever the others did or did not do.
  if (failures.length > 0) {
    console.error("\nOver budget:");
    for (const f of failures) console.error("  · " + f);
    return OVER_BUDGET;
  }
  if (missing.length > 0) {
    console.error(
      `\nNot measured: ${missing.join(", ")}.\n` +
        "The gestures that did produce a number are within budget, but this run\n" +
        "does not say the app is fast: it says it was not measured (exit 2).",
    );
    return NOT_MEASURED;
  }
  console.log("\nAll three under budget.");
  return 0;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

process.exit(main());
