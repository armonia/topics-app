#!/usr/bin/env bun
/**
 * TIME, as a published report: how long the gestures a working day is made of
 * take, on the machine that ran them.
 *
 * WHY A REPORT AND NOT A GATE. `scripts/check-ink-latency.ts` and
 * `scripts/check-drag-frames.ts` are gates: a budget, a comparison, a red. This
 * is the other half — numbers meant to be READ and published, on the axes a
 * workspace has and a terminal does not. There is no budget here on purpose: a
 * threshold on boot time would be a threshold on the laptop that ran it.
 *
 * WHAT IT DOES NOT MEASURE, AND WHY THAT MATTERS. Three of the six gestures are
 * already owned by `tests/e2e/ink-latency.spec.ts`, and its numbers are
 * published in `tests/e2e/ink-budget.json`. Those are READ from that file here,
 * never re-measured: a second measurement of the same gesture would differ by a
 * millisecond and start an argument about which one is true. The rows say where
 * each number came from, in the table itself.
 *
 * WHAT IT ADDS:
 *   app boot → first frame          nobody measured it
 *   app boot → sidebar usable       nobody measured it
 *   open a topic COLD               deliberately EXCLUDED from the ink budget,
 *                                   because ~320 ms of it is a curtain held on
 *                                   purpose (LIST_REVEAL_FLOOR_MS). Reported
 *                                   here with that composition written next to
 *                                   the number, which is the only honest way to
 *                                   publish it.
 *   board paint at 50/200/500       nobody measured it, and it is the shape of
 *                                   the claim: what the N-th unit costs.
 *
 * WHERE EACH PIECE LIVES
 *   the measurement   tests/e2e/bench-latency.spec.ts   (drives the app, writes the JSON)
 *   the ink numbers   tests/e2e/ink-budget.json         (read, not re-measured)
 *   the curtain       client/src/components/Chat/MessageList.tsx (read from the source)
 *   the report        here
 *
 * EXIT CODES
 *   0  the report was produced
 *   1  the measurement is present but cannot be trusted (a number that cannot be
 *      true), or, under `--stall`, the bench did NOT notice an injected defect
 *   2  nothing to report on (no measurement, no ink baseline, stale measurement)
 *
 * There is no "regression" code, because there is no budget. Code 1 accuses the
 * HARNESS, which is the only thing a report can be wrong about.
 *
 * USAGE
 *   bun run scripts/bench/latency.ts                 measure, then report
 *   bun run scripts/bench/latency.ts --no-run        report the last measurement
 *   bun run scripts/bench/latency.ts --stall 120     the falsification lever: measure
 *                                                    again with 120 ms burned per boot
 *                                                    frame and check that every number
 *                                                    moved. A bench nobody can watch
 *                                                    fail is decoration.
 *   bun run scripts/bench/latency.ts --json          the same verdict, machine-readable
 *
 * The measurement runs against the isolated E2E server the Playwright
 * globalSetup starts, so it needs a built client bundle like the rest of the
 * suite: `bun run build:client`, or point TOPICS_E2E_BUNDLE_DIR at a bundle
 * built elsewhere. E2E_PORT is honoured when set, and BENCH_LATENCY_ARTIFACTS
 * moves Playwright's traces and videos out of the shared `test-results/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const SPEC = "tests/e2e/bench-latency.spec.ts";
const MEASURE_PATH = join(REPO_ROOT, "test-results/bench-latency.json");
const STALLED_PATH = join(REPO_ROOT, "test-results/bench-latency-stalled.json");
const INK_BUDGET_PATH = join(REPO_ROOT, "tests/e2e/ink-budget.json");
const MESSAGE_LIST_PATH = join(REPO_ROOT, "client/src/components/Chat/MessageList.tsx");

// ---------------------------------------------------------------- the shapes --

export interface Gesture {
  label: string;
  metric: string;
  samples: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface BenchMeasure {
  measured_at?: string;
  stall_ms: number;
  samples_per_gesture: number;
  board_samples_per_volume: number;
  machine: {
    platform: string;
    arch: string;
    cpus: number;
    cpu_model: string;
    memory_gb: number;
    browser: string;
    viewport: string;
  };
  gestures: Record<string, Gesture>;
  witness: Record<string, number | string>;
}

/** The `baseline` block of `tests/e2e/ink-budget.json`. The only thing read from it. */
export interface InkBaseline {
  measuredOn: string;
  how: string;
  card: InkRow;
  tab: InkRow;
  send: InkRow;
}

interface InkRow {
  medianMs: number;
  spreadMs: string;
  what: string;
}

export interface ReportRow {
  gesture: string;
  medianMs: number;
  range: string;
  source: string;
  note?: string;
}

export interface Report {
  code: 0 | 1 | 2;
  rows: ReportRow[];
  /** Why nothing can be reported. Exit 2. */
  blockers: string[];
  /** Numbers that cannot be true. Exit 1. */
  untrustworthy: string[];
  /** Said out loud under the table: composition, machine, what is not measured here. */
  notes: string[];
}

// ------------------------------------------------------------- reading files --

/**
 * Read a measurement, and refuse anything that is merely valid JSON.
 *
 * The trap: `tests/e2e/ink-budget.json` and this file are both JSON with a
 * `medianMs` somewhere inside. Reading one as the other has to fail loudly
 * rather than report whatever fields happen to line up.
 */
export function readMeasure(path: string): BenchMeasure {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isMeasure(raw)) {
    throw new Error(`${path} is valid JSON but not the shape of a bench-latency measurement`);
  }
  return raw;
}

function isMeasure(value: unknown): value is BenchMeasure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.gestures !== "object" || v.gestures === null) return false;
  if (typeof v.machine !== "object" || v.machine === null) return false;
  if (typeof v.stall_ms !== "number") return false;
  return true;
}

export function readInkBaseline(path: string): InkBaseline {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { baseline?: unknown };
  const b = raw.baseline;
  if (typeof b !== "object" || b === null) {
    throw new Error(`${path} has no 'baseline' block: there is nothing to read from it`);
  }
  const row = (name: "card" | "tab" | "send"): InkRow => {
    const r = (b as Record<string, unknown>)[name];
    if (typeof r !== "object" || r === null || typeof (r as InkRow).medianMs !== "number") {
      throw new Error(`${path}: baseline.${name} is missing or has no medianMs`);
    }
    return r as InkRow;
  };
  const meta = b as Record<string, unknown>;
  return {
    measuredOn: String(meta.measuredOn ?? "unknown date"),
    how: String(meta.how ?? "unknown conditions"),
    card: row("card"),
    tab: row("tab"),
    send: row("send"),
  };
}

/**
 * The curtain, read from the SOURCE that holds it.
 *
 * Copying 320 into this file would make the report drift the day the constant
 * changes, and the whole point of naming the composition is that it stays true.
 * `ink-budget.json` already says the same thing about how this number would be
 * gated: by the constant that causes it, not by a stopwatch.
 */
export function readCurtainMs(source: string): number | null {
  const match = /LIST_REVEAL_FLOOR_MS\s*=\s*(\d+)/.exec(source);
  return match ? Number(match[1]) : null;
}

// -------------------------------------------------------------- the verdict --

/**
 * Build the table. Pure: it decides, it does not measure, so it can be tested
 * without a browser anywhere near it.
 */
export function buildReport(input: {
  measure: BenchMeasure | null;
  ink: InkBaseline | null;
  curtainMs: number | null;
  /** When set, a measurement taken before this instant is stale and reports nothing. */
  freshAfter?: Date;
}): Report {
  const { measure, ink, curtainMs, freshAfter } = input;
  const blockers: string[] = [];
  const untrustworthy: string[] = [];
  const notes: string[] = [];
  const rows: ReportRow[] = [];

  if (!measure) blockers.push("no measurement: run without --no-run");
  if (!ink) blockers.push(`no ink baseline: ${INK_BUDGET_PATH} is missing or has no baseline block`);

  if (measure && freshAfter) {
    if (!measure.measured_at) {
      blockers.push("the measurement carries no measured_at, so it cannot be shown to be this run's");
    } else if (new Date(measure.measured_at).getTime() < freshAfter.getTime()) {
      blockers.push(
        `the measurement is from ${measure.measured_at}, BEFORE this run: it describes an older build`,
      );
    }
  }

  if (blockers.length > 0) return { code: 2, rows, blockers, untrustworthy, notes };
  // Both are non-null past the guard above; the checks are what proves it.
  const m = measure as BenchMeasure;
  const i = ink as InkBaseline;

  if (m.stall_ms > 0) {
    notes.push(
      `THIS MEASUREMENT IS DELIBERATELY SLOW: ${m.stall_ms} ms burned per boot frame and per ` +
        "pointerdown. It is the falsification lever, not a number to publish.",
    );
  }

  const measured = (key: string, label: string, note?: string): void => {
    const g = m.gestures[key];
    if (!g) {
      untrustworthy.push(`${label}: not measured at all, though the run reported success`);
      return;
    }
    if (!(g.medianMs > 0)) {
      untrustworthy.push(`${label}: median ${g.medianMs} ms — a gesture cannot take zero or less`);
    }
    if (g.samples.length === 0) {
      untrustworthy.push(`${label}: no samples behind the median`);
    }
    rows.push({
      gesture: label,
      medianMs: g.medianMs,
      range: `${g.minMs}-${g.maxMs}`,
      source: `measured here (n=${g.samples.length})`,
      note,
    });
  };

  measured("boot_first_frame", "app boot → first frame");
  measured("boot_interactive", "app boot → sidebar usable");

  const cold = m.gestures.topic_open_cold;
  measured(
    "topic_open_cold",
    "open a topic, COLD",
    curtainMs === null
      ? "composition unknown: LIST_REVEAL_FLOOR_MS was not found in MessageList.tsx"
      : cold
        ? `${curtainMs} ms of it is LIST_REVEAL_FLOOR_MS, a curtain held on purpose so nobody ` +
          `watches virtuoso measure heights; the app's own work is the other ` +
          `${round1(cold.medianMs - curtainMs)} ms`
        : undefined,
  );

  // The three the ink bench already owns. READ, never re-measured.
  rows.push({
    gesture: "open a topic, WARM (already open)",
    medianMs: i.tab.medianMs,
    range: i.tab.spreadMs,
    source: "tests/e2e/ink-budget.json",
    note: "the same gesture as switching between two open topics: clicking a resident pane tab",
  });
  rows.push({
    gesture: "open a task card → drawer readable",
    medianMs: i.card.medianMs,
    range: i.card.spreadMs,
    source: "tests/e2e/ink-budget.json",
  });
  rows.push({
    gesture: "switch between two open topics",
    medianMs: i.tab.medianMs,
    range: i.tab.spreadMs,
    source: "tests/e2e/ink-budget.json",
    note: "one measurement, not two: in this app it is the same click as a warm topic open",
  });
  rows.push({
    gesture: "send a message → readable in the list",
    medianMs: i.send.medianMs,
    range: i.send.spreadMs,
    source: "tests/e2e/ink-budget.json",
  });

  const bootMs = m.gestures.boot_interactive?.medianMs ?? 0;
  for (const key of Object.keys(m.gestures).filter((k) => k.startsWith("board_paint_")).sort(bySeededVolume)) {
    const volume = Number(key.slice("board_paint_".length));
    const rendered = m.witness[`board_cards_rendered_${volume}`];
    measured(
      key,
      `board painted, ${volume} cards`,
      `from navigation start, so the ${round1(bootMs)} ms of shell boot are inside this ` +
        `number; ${typeof rendered === "number" ? rendered : "?"} cards really in the DOM`,
    );
  }

  notes.push(
    `machine: ${m.machine.cpu_model}, ${m.machine.cpus} cores, ${m.machine.memory_gb} GB, ` +
      `${m.machine.platform}/${m.machine.arch}, ${m.machine.browser}, ${m.machine.viewport}`,
  );
  notes.push(`ink numbers measured ${i.measuredOn} — ${i.how}`);
  notes.push(
    "the ink rows are READ from the budget file, not re-measured: two measurements of one " +
      "gesture is how a number ends up with two values",
  );

  return {
    code: untrustworthy.length > 0 ? 1 : 0,
    rows,
    blockers,
    untrustworthy,
    notes,
  };
}

/** `board_paint_500` after `board_paint_50`: string order would put 200 first. */
function bySeededVolume(a: string, b: string): number {
  return Number(a.slice("board_paint_".length)) - Number(b.slice("board_paint_".length));
}

// ------------------------------------------------------ the falsification --

export interface StallVerdict {
  code: 0 | 1 | 2;
  rows: string[];
  blockers: string[];
  deaf: string[];
}

/**
 * Did the bench NOTICE the injected defect?
 *
 * A report has no budget, so it cannot go red for a regression — which would
 * leave nobody able to watch it fail. This is the equivalent question, and it
 * has an answer: with `stallMs` burned inside every boot frame and every
 * pointerdown, every published number MUST rise. One that does not is measuring
 * something other than what it claims, and that is worth an exit code.
 *
 * The bar is half the injected stall, not the whole of it: a frame-paced burn
 * lands on a variable number of frames per gesture, so requiring the full amount
 * would make the check itself fragile. Half is far outside the noise measured
 * between two clean runs (under 5 ms on every gesture).
 */
export function compareStall(
  clean: BenchMeasure,
  stalled: BenchMeasure,
  stallMs: number,
): StallVerdict {
  const blockers: string[] = [];
  const deaf: string[] = [];
  const rows: string[] = [];

  if (!(stallMs > 0)) blockers.push("--stall wants a positive number of milliseconds");
  if (stalled.stall_ms !== stallMs) {
    blockers.push(
      `the stalled measurement says stall_ms=${stalled.stall_ms}, not ${stallMs}: it is not the run that was asked for`,
    );
  }
  if (clean.stall_ms !== 0) {
    blockers.push(`the reference measurement was itself taken with a ${clean.stall_ms} ms stall`);
  }
  if (blockers.length > 0) return { code: 2, rows, blockers, deaf };

  const bar = stallMs / 2;
  for (const [key, before] of Object.entries(clean.gestures)) {
    const after = stalled.gestures[key];
    if (!after) {
      deaf.push(`${key}: missing from the stalled run, so nothing can be said about it`);
      continue;
    }
    const delta = round1(after.medianMs - before.medianMs);
    rows.push(
      `${pad(key, 26)}${pad(`${before.medianMs} ms`, 12)}→ ${pad(`${after.medianMs} ms`, 12)}${delta >= bar ? "noticed" : "DEAF"}   (+${delta} ms)`,
    );
    if (delta < bar) {
      deaf.push(
        `${key}: only +${delta} ms under a ${stallMs} ms stall (at least +${bar} ms expected). ` +
          "This number is not measuring the thing it names.",
      );
    }
  }

  return { code: deaf.length > 0 ? 1 : 0, rows, blockers, deaf };
}

// ------------------------------------------------------------------ output --

export function printReport(report: Report): void {
  if (report.blockers.length > 0) {
    console.error("\nNOT MEASURABLE — nothing is being reported:");
    for (const b of report.blockers) console.error("  · " + b);
    return;
  }

  console.log("\nTIME — the gestures a working day is made of");
  console.log("  " + pad("gesture", 38) + pad("median", 12) + pad("range", 18) + "source");
  for (const row of report.rows) {
    console.log(
      "  " +
        pad(row.gesture, 38) +
        pad(`${row.medianMs} ms`, 12) +
        pad(row.range, 18) +
        row.source,
    );
    if (row.note) console.log("      " + row.note);
  }
  console.log("");
  for (const note of report.notes) console.log("  " + note);

  if (report.untrustworthy.length > 0) {
    console.error("\nNumbers that cannot be true — the harness, not the app:");
    for (const u of report.untrustworthy) console.error("  · " + u);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// -------------------------------------------------------------------- main --

function measureOnce(outPath: string, stallMs: number): boolean {
  // Typed as a dictionary, not inferred from the literal: an inferred type has
  // exactly the keys written here, and the next line would not be allowed to add one.
  const env: Record<string, string | undefined> = { ...process.env, BENCH_LATENCY_OUT: outPath };
  if (stallMs > 0) env.BENCH_LATENCY_STALL_MS = String(stallMs);
  console.log(
    stallMs > 0
      ? `Measuring with ${stallMs} ms burned per boot frame and per pointerdown…`
      : "Measuring…",
  );
  // Traces, videos and screenshots land where BENCH_LATENCY_ARTIFACTS says, when
  // it says anything. Two checkouts benching at once would otherwise write into
  // the same `test-results/` and delete each other's evidence.
  const artifacts = process.env.BENCH_LATENCY_ARTIFACTS?.trim();
  const argv = ["playwright", "test", SPEC, "--reporter=line"];
  if (artifacts) argv.push(`--output=${artifacts}`);
  const run = spawnSync("npx", argv, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return run.status === 0;
}

function main(): number {
  const args = process.argv.slice(2);
  const noRun = args.includes("--no-run");
  const asJson = args.includes("--json");
  const stallAt = args.indexOf("--stall");
  const stallMs = stallAt >= 0 ? Number(args[stallAt + 1]) : 0;
  if (stallAt >= 0 && (!Number.isFinite(stallMs) || stallMs <= 0)) {
    console.error("bench/latency — --stall wants a positive number of milliseconds");
    return 2;
  }
  const startedAt = new Date();

  if (stallMs > 0) {
    // The falsification lever needs both halves: a clean reference and a run
    // with the defect in it. The clean one is never overwritten by this path.
    if (!existsSync(MEASURE_PATH)) {
      console.error(
        `bench/latency — --stall compares against a clean measurement, and ${MEASURE_PATH} does not exist.\n` +
          "Run the bench without --stall first.",
      );
      return 2;
    }
    if (!measureOnce(STALLED_PATH, stallMs)) {
      console.error("bench/latency — the stalled measurement did not complete. Nothing is being compared.");
      return 2;
    }
    const verdict = compareStall(readMeasure(MEASURE_PATH), readMeasure(STALLED_PATH), stallMs);
    if (asJson) {
      console.log(JSON.stringify(verdict, null, 2));
      return verdict.code;
    }
    console.log(`\nFALSIFICATION — every number must move under a ${stallMs} ms stall\n`);
    for (const row of verdict.rows) console.log("  " + row);
    if (verdict.blockers.length > 0) {
      console.error("\nThe comparison could not be made:");
      for (const b of verdict.blockers) console.error("  · " + b);
    }
    if (verdict.deaf.length > 0) {
      console.error("\nDeaf to an injected defect:");
      for (const d of verdict.deaf) console.error("  · " + d);
    } else if (verdict.code === 0) {
      console.log("\nEvery gesture noticed. The bench measures what it names.");
    }
    return verdict.code;
  }

  if (!noRun && !measureOnce(MEASURE_PATH, 0)) {
    console.error(
      "\nbench/latency — the measurement did not complete (playwright exited non-zero).\n" +
        "Nothing was measured, so nothing is being reported.",
    );
    return 2;
  }

  const report = buildReport({
    measure: existsSync(MEASURE_PATH) ? readMeasure(MEASURE_PATH) : null,
    ink: existsSync(INK_BUDGET_PATH) ? readInkBaseline(INK_BUDGET_PATH) : null,
    curtainMs: existsSync(MESSAGE_LIST_PATH)
      ? readCurtainMs(readFileSync(MESSAGE_LIST_PATH, "utf8"))
      : null,
    freshAfter: noRun ? undefined : startedAt,
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return report.code;
  }
  printReport(report);
  return report.code;
}

// Importable by the unit test without running the bench: only the CLI exits.
if (import.meta.main) process.exit(main());
