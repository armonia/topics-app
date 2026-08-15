#!/usr/bin/env bun
/**
 * THE DRAG FRAME-TIME GATE.
 *
 *   bun run check:drag                        measure, then judge
 *   bun run check:drag -- --from FILE.json    judge a measurement already taken
 *   bun run check:drag -- --update-baseline   record the new numbers
 *   TOPICS_DRAG_JANK_MS=40 bun run check:drag prove it can go red
 *
 * WHY. The goal states a stable 60 FPS during drag, and the board is the
 * product's core surface. Nothing here measured what the main thread does WHILE
 * the pointer is down: `check:fluido` measures scrolling a virtualised
 * transcript, which is a different machine (virtuoso mounting rows) from a drag
 * (dnd-kit running collision detection against every droppable on every pointer
 * move, plus the overlay and the board's own state). A regression in one is
 * invisible to the other.
 *
 * WHO DOES WHAT. The MEASUREMENT is `tests/e2e/board-drag-frames.spec.ts`,
 * which drives a real paced pointer and writes a JSON; the JUDGEMENT is here.
 * The split is not cosmetic: inside the suite that spec fails only when the
 * bench itself did not work, never on a threshold, so the suite does not go red
 * because a laptop was indexing. The threshold bites when somebody asks for it,
 * which is what running this command means.
 *
 * THREE NUMBERS, because a drag stops being 60 FPS in three ways that do not
 * imply each other: the 95th percentile frame (the continuous lag behind the
 * pointer), the single worst frame (the catch, which a p95 over 60 frames
 * hides) and the count of long tasks (the CAUSE: work on the main thread).
 *
 * THREE EXITS:
 *   0  inside the budget
 *   1  REGRESSION: dragging got heavier
 *   2  NOT MEASURABLE: the measurement does not speak about the product (a
 *      machine that delivers no frames even at rest, a bench whose drop never
 *      landed, a measurement older than the run) or the baseline has never been
 *      recorded on a real run. A gate that confuses those with a regression
 *      stops being believed, which is worse than no gate.
 *
 * HOW TO SEE IT RED. `TOPICS_DRAG_JANK_MS=40` burns 40 ms inside a real
 * capture-phase `pointermove` listener: work proportional to drag events, which
 * is the shape of the defect this gate exists for. Lowering the threshold would
 * only prove that a comparison operator works.
 *
 * The number has to clear the budget ON ITS OWN, and that is not obvious.
 * Measured on this machine, 2026-08-15: the app's own drag work is about 1 ms a
 * frame (p95 9.5 ms against a 16.7 ms budget, 0 long tasks), and the browser
 * COALESCES pointer moves to one per frame, so injecting 12 ms produced a p95 of
 * 10 ms and the gate stayed green. That reads like a broken gate and is not one:
 * 12 ms of extra work genuinely fits in a frame. 40 ms gives p95 40.8 ms and
 * exit 1.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/drag-frames-baseline.json");
const SPEC_PATH = "tests/e2e/board-drag-frames.spec.ts";
const DEFAULT_OUT = join(REPO_ROOT, "test-results/drag-frames-measure.json");

export interface DragMeasure {
  measured_at?: string;
  jank_injected_ms?: number;
  calibration_gap_ms: number;
  median: {
    p95_frame_ms: number;
    worst_frame_ms: number;
    longtask_count: number;
    p50_frame_ms?: number;
    longtask_ms?: number;
    frames_over_16_7ms?: number;
  };
  witness: {
    frames: number;
    pointer_moves: number;
    drag_span_px: number;
    cards_rendered: number;
    drops_committed: number;
  };
}

export interface DragBaseline {
  /** False until a real run wrote real numbers here. See `recorded_why`. */
  recorded: boolean;
  budget: { p95_frame_ms: number; worst_frame_ms: number; longtask_count: number };
  guards: {
    calibration_gap_ms_ceiling: number;
    frames_floor: number;
    drag_span_px_floor: number;
    cards_rendered_floor: number;
    drops_committed_floor: number;
  };
  update_rule: Record<string, { floor: number; multiplier: number }>;
}

/** 0 green, 1 regression, 2 not measurable. See the header. */
export type ExitCode = 0 | 1 | 2;

export interface DragOutcome {
  code: ExitCode;
  /** The measured-against-budget rows, always printed. */
  rows: string[];
  /** What went over. Empty unless the code is 1. */
  over: string[];
  /** Why the measurement is worth nothing. Empty unless the code is 2. */
  blockers: string[];
  /** True when the baseline has never been recorded against a real run. */
  unrecorded: boolean;
}

/** The three judged metrics in one place: key, label, unit. */
const METRICS = [
  { key: "p95_frame_ms", label: "p95 frame", unit: "ms" },
  { key: "worst_frame_ms", label: "worst frame", unit: "ms" },
  { key: "longtask_count", label: "long tasks", unit: "" },
] as const;

/**
 * The judgement, pure: two objects in, one outcome out.
 *
 * Pure so it is falsifiable without a browser: `scripts/check-drag-frames.test.ts`
 * feeds it synthetic measurements, including the ones that MUST come out red.
 *
 * `notBefore`, when present, is the instant the measurement run started. A
 * measurement older than the run is an artefact of an earlier one, and judging
 * it would hand a green to code that was never exercised.
 */
export function judge(m: DragMeasure, b: DragBaseline, notBefore?: Date): DragOutcome {
  const rows: string[] = [];
  const over: string[] = [];
  const blockers: string[] = [];

  for (const { key, label, unit } of METRICS) {
    const got = m.median[key];
    const max = b.budget[key];
    const within = got <= max;
    rows.push(
      `${within ? "  " : "! "}${label.padEnd(13)} ${String(got).padStart(8)} ${unit.padEnd(2)}` +
        `   budget ${max} ${unit}`,
    );
    if (!within) over.push(`${key}: ${got}${unit} > ${max}${unit}`);
  }

  const g = b.guards;

  /**
   * A MISSING WITNESS ACCUSES, it does not stay silent.
   *
   * Written this way because the sibling gate had the opposite bug: with the
   * field absent, `undefined < floor` is false, so no blocker and a green exit.
   * Renaming a field in the spec would switch off the defence this gate claims
   * as its own, silently and for good.
   */
  const numberOrNothing = (v: unknown, name: string): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    blockers.push(
      `the witness \`${name}\` is not a number (${JSON.stringify(v)}): without it ` +
        `there is no way to know the bench measured anything, and a measurement ` +
        `that may not have happened is not judged`,
    );
    return null;
  };

  if (m.calibration_gap_ms > g.calibration_gap_ms_ceiling) {
    blockers.push(
      `calibration ${m.calibration_gap_ms}ms > ${g.calibration_gap_ms_ceiling}ms: ` +
        `this machine delivers no frames even on a blank page, so anything collected ` +
        `during a drag speaks about the machine and not about the app`,
    );
  }
  const frames = numberOrNothing(m.witness?.frames, "frames");
  if (frames !== null && frames < g.frames_floor) {
    blockers.push(
      `the recorder collected ${frames} frames < ${g.frames_floor}: too few for a ` +
        `percentile to mean anything`,
    );
  }
  const span = numberOrNothing(m.witness?.drag_span_px, "drag_span_px");
  if (span !== null && span < g.drag_span_px_floor) {
    blockers.push(
      `the pointer travelled ${span}px < ${g.drag_span_px_floor}px: that is not a drag`,
    );
  }
  const cards = numberOrNothing(m.witness?.cards_rendered, "cards_rendered");
  if (cards !== null && cards < g.cards_rendered_floor) {
    blockers.push(
      `the board drew ${cards} cards < ${g.cards_rendered_floor}: an empty board is ` +
        `fast for everybody, and this gate exists for a board with a real volume on it`,
    );
  }
  const committed = numberOrNothing(m.witness?.drops_committed, "drops_committed");
  if (committed !== null && committed < g.drops_committed_floor) {
    blockers.push(
      `only ${committed} of ${g.drops_committed_floor} drops reached the server: ` +
        `the passes that did not land measured a mouse moving over a static board`,
    );
  }
  if (notBefore && !m.measured_at) {
    blockers.push(
      "the measurement carries no `measured_at`: there is no way to tell whether it " +
        "belongs to this run or is the artefact of an earlier one",
    );
  }
  if (notBefore && m.measured_at && new Date(m.measured_at) < notBefore) {
    blockers.push(
      `the measurement is from ${m.measured_at}, that is BEFORE this run: it is the ` +
        `artefact of an earlier one and says nothing about the code as it is now`,
    );
  }

  // A blocker outranks an overrun: if the measurement is worthless, the red it
  // would give would be a red on a worthless measurement.
  const unrecorded = b.recorded !== true;
  const code: ExitCode = blockers.length > 0 ? 2 : unrecorded ? 2 : over.length > 0 ? 1 : 0;
  return { code, rows, over, blockers, unrecorded };
}

/**
 * The new budgets from a new measurement, with the rule declared in the baseline.
 *
 * The FLOOR matters because the healthy value of two of these three is expected
 * to be at or near zero: without it, `--update-baseline` would write a budget of
 * zero, a threshold no run can meet, and the gate would become noise to switch off.
 */
export function updatedBudget(
  m: DragMeasure,
  b: DragBaseline,
): { p95_frame_ms: number; worst_frame_ms: number; longtask_count: number } {
  const one = (key: (typeof METRICS)[number]["key"]): number => {
    const rule = b.update_rule[key];
    if (!rule) return b.budget[key];
    return Math.max(rule.floor, Math.round(m.median[key] * rule.multiplier * 100) / 100);
  };
  return {
    p95_frame_ms: one("p95_frame_ms"),
    worst_frame_ms: one("worst_frame_ms"),
    longtask_count: one("longtask_count"),
  };
}

/** Defensive read: valid JSON with the wrong shape is not a measurement. */
export function readMeasure(path: string): DragMeasure {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DragMeasure>;
  if (!raw.median || !raw.witness || typeof raw.calibration_gap_ms !== "number") {
    throw new Error(
      `${path} does not have the shape of a measurement (median, witness, calibration_gap_ms are required).`,
    );
  }
  return raw as DragMeasure;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update-baseline");
  const fromAt = argv.indexOf("--from");
  const from = fromAt >= 0 ? argv[fromAt + 1] : undefined;
  if (fromAt >= 0 && !from) {
    console.error("check:drag - --from wants a path.");
    process.exit(2);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as DragBaseline;
  // `resolve` and not `join`: with an absolute path `join` would glue it onto
  // the repo root and the file would "not exist" for a fake reason.
  const outPath = from ? resolve(REPO_ROOT, from) : DEFAULT_OUT;
  let notBefore: Date | undefined;

  // The never-recorded baseline is answered BEFORE the bench is spawned, not
  // after. Measuring first would spend minutes of e2e time to reach a verdict
  // that is already known: with no recorded number there is nothing to compare
  // against. `--update-baseline` is the one flag that still has to measure,
  // because measuring is how the number gets recorded.
  if (!from && !update && baseline.recorded !== true) {
    console.error(
      `! BASELINE NEVER RECORDED, so there is nothing to judge and the bench is not run.\n` +
        `  The numbers in ${BASELINE_PATH} come from the product goal (60 FPS), not from\n` +
        `  this bench. Record them on an idle machine and commit the diff:\n\n` +
        `      bun run check:drag -- --update-baseline\n`,
    );
    process.exit(2);
  }

  if (!from) {
    notBefore = new Date();
    console.log(`> measuring ${SPEC_PATH} (e2e bench, a few minutes: it seeds 150 closed cards)\n`);
    const run = spawnSync("npx", ["playwright", "test", SPEC_PATH, "--reporter=list"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      // E2E_PORT and TOPICS_E2E_BUNDLE_DIR pass through untouched, so a worktree
      // or a machine without a client watcher stays as governable as the rest of
      // the suite. TOPICS_DRAG_JANK_MS passes through the same way.
      env: { ...process.env, TOPICS_DRAG_OUT: outPath },
    });
    if (run.status !== 0) {
      console.error(
        `\n! The bench did not finish (exit ${run.status}).\n` +
          `  This is not a verdict on drag performance: with no measurement there is nothing to judge.`,
      );
      process.exit(2);
    }
  }

  if (!existsSync(outPath)) {
    console.error(`! No measurement at ${outPath}.`);
    process.exit(2);
  }

  let measure: DragMeasure;
  try {
    measure = readMeasure(outPath);
  } catch (e) {
    console.error(`! ${(e as Error).message}`);
    process.exit(2);
  }

  console.log(`surface        kanban board, a card dragged across columns (dnd-kit)`);
  console.log(
    `witnesses      ${measure.witness.frames} frames, ${measure.witness.drag_span_px}px travelled, ` +
      `${measure.witness.cards_rendered} cards drawn, ${measure.witness.drops_committed} drops committed`,
  );
  console.log(
    `calibration    ${measure.calibration_gap_ms} ms at rest on a blank page ` +
      `(ceiling ${baseline.guards.calibration_gap_ms_ceiling} ms)`,
  );
  if (measure.jank_injected_ms) {
    console.log(
      `\n! SLOWNESS INJECTED: ${measure.jank_injected_ms} ms burned inside every pointermove.\n` +
        `  This measurement exists to watch the gate fail, not to judge the repo.`,
    );
  }
  console.log("");

  const outcome = judge(measure, baseline, notBefore);
  for (const r of outcome.rows) console.log(r);

  if (update) {
    if (outcome.blockers.length > 0) {
      console.error(`\n! I do not record a measurement that is worth nothing:\n  - ${outcome.blockers.join("\n  - ")}`);
      process.exit(2);
    }
    // A REGRESSION IS NOT QUIETLY RECORDED AS THE NEW NORMAL. If the measurement
    // is over budget the baseline is still written, so the diff shows what the
    // new number bought, but the exit stays 1: nobody gets to call that run green.
    let updateExit: ExitCode = 0;
    if (outcome.over.length > 0 && baseline.recorded === true) {
      console.error(
        `\n! Recording the baseline ON A WORSENED MEASUREMENT:\n  - ${outcome.over.join("\n  - ")}\n` +
          `  The exit stays 1: if the cost is deliberate, the commit has to say so.`,
      );
      updateExit = 1;
    }
    const next = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
    next.recorded = true;
    next.updated = new Date().toISOString().slice(0, 10);
    next.measured = {
      p95_frame_ms: measure.median.p95_frame_ms,
      p50_frame_ms: measure.median.p50_frame_ms ?? null,
      worst_frame_ms: measure.median.worst_frame_ms,
      longtask_count: measure.median.longtask_count,
      longtask_ms: measure.median.longtask_ms ?? null,
      calibration_gap_ms: measure.calibration_gap_ms,
      cards_rendered: measure.witness.cards_rendered,
    };
    const budget = next.budget as Record<string, unknown>;
    next.budget = { _: budget?._, ...updatedBudget(measure, baseline) };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `\n> Baseline recorded in ${BASELINE_PATH}.\n` +
        `  Update \`budget_why\` by hand too: a number without its reason is a number the\n` +
        `  next person raises again without asking themselves anything.`,
    );
    process.exit(updateExit);
  }

  if (outcome.blockers.length > 0) {
    console.error(`\n! MEASUREMENT UNUSABLE:\n  - ${outcome.blockers.join("\n  - ")}`);
    console.error(`\nNo verdict on drag performance: the measurement does not speak about the product.`);
    process.exit(2);
  }

  if (outcome.unrecorded) {
    console.error(
      `\n! BASELINE NEVER RECORDED. The numbers in ${BASELINE_PATH} come from the product\n` +
        `  goal (60 FPS), not from this bench: no run has ever written a real number there.\n` +
        `  Record it on an idle machine and commit the diff:\n\n` +
        `      bun run check:drag -- --update-baseline\n\n` +
        `  Exit 2, not 0: a budget that has never seen a real number cannot tell "fine"\n` +
        `  from "the bench measured nothing".`,
    );
    process.exit(2);
  }

  if (outcome.code === 1) {
    console.error(`\n! Dragging got heavier:\n  - ${outcome.over.join("\n  - ")}`);
    console.error(
      `\nWhere to look: a growing long-task count means work on the main thread inside the\n` +
        `gesture (a column re-rendering per pointer move, a collision detector walking every\n` +
        `card, a card subtree that is not memoised). If the cost is deliberate, raise the\n` +
        `number in ${BASELINE_PATH} IN THE SAME commit, with the reason in \`budget_why\`,\n` +
        `so the diff shows what it bought.`,
    );
    process.exit(1);
  }

  console.log("\n> Drag inside the budget.");
  process.exit(0);
}
