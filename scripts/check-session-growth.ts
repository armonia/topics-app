#!/usr/bin/env bun
/**
 * THE LONG-SESSION GROWTH GATE.
 *
 *   bun run check:growth                        measure, then judge
 *   bun run check:growth -- --from FILE.json    judge a measurement already taken
 *   bun run check:growth -- --update-baseline   record the new numbers
 *   TOPICS_GROWTH_LEAK_NODES=120 bun run check:growth   prove it can go red
 *
 * WHY. The goal asks for no meaningful progressive heap, DOM node, listener or
 * process growth during long sessions. Every other gate here takes ONE sample:
 * bundle bytes at build time, the latency of one gesture, the frames of one
 * scroll. A leak is invisible to all of them by construction, because a leak is
 * a derivative and they measure a point.
 *
 * WHAT IS JUDGED. Three ratios of the cycle-50 sample over the cycle-5 sample,
 * one per metric, because they fail for different reasons and rarely together:
 * heap says something is retained, DOM nodes say a subtree outlived its owner,
 * listeners say a cleanup stopped running. A ratio and not a number so the bar
 * survives a different machine: an absolute megabyte figure is a fact about the
 * laptop that took it.
 *
 * WHO DOES WHAT. The MEASUREMENT is `tests/e2e/long-session-growth.spec.ts`,
 * which drives fifty cycles of the same interaction and writes a JSON; the
 * JUDGEMENT is here. Same split as the fluidity and drag gates, for the same
 * reason: the suite must not go red because a laptop was busy.
 *
 * THREE EXITS:
 *   0  flat enough
 *   1  GROWTH: something accumulates cycle after cycle
 *   2  NOT MEASURABLE: the run did not do enough cycles, the first sample is too
 *      small for a ratio to mean anything, the collection was never forced, the
 *      measurement predates the run, or the baseline has never been recorded.
 *
 * HOW TO SEE IT RED. `TOPICS_GROWTH_LEAK_NODES=120` appends retained nodes,
 * listeners and payloads per cycle, held by a global array so a forced
 * collection cannot reclaim them. It is a real leak of the shape this gate
 * claims to catch, not a lowered threshold.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/session-growth-baseline.json");
const SPEC_PATH = "tests/e2e/long-session-growth.spec.ts";
const DEFAULT_OUT = join(REPO_ROOT, "test-results/session-growth-measure.json");

export interface GrowthSample {
  cycle: number;
  heap_bytes: number;
  dom_nodes: number;
  listeners: number;
  retained_nodes?: number;
  documents?: number;
}

export interface GrowthMeasure {
  measured_at?: string;
  leak_injected_nodes?: number;
  protocol?: { cycles?: number; baseline_cycle?: number; final_cycle?: number };
  ratio: { heap: number; dom_nodes: number; listeners: number; retained_nodes?: number };
  witness: {
    cycles_completed: number;
    panes_reopened: number;
    messages_streamed: number;
    gc_forced: boolean;
    first: GrowthSample;
    last: GrowthSample;
  };
}

export interface GrowthBaseline {
  /** False until a real run wrote real numbers here. See `recorded_why`. */
  recorded: boolean;
  budget: { heap: number; dom_nodes: number; listeners: number };
  guards: {
    cycles_completed_floor: number;
    panes_reopened_floor: number;
    messages_streamed_floor: number;
    first_heap_bytes_floor: number;
    first_dom_nodes_floor: number;
  };
  update_rule: Record<string, { floor: number; margin: number }>;
}

/** 0 flat, 1 growth, 2 not measurable. See the header. */
export type ExitCode = 0 | 1 | 2;

export interface GrowthOutcome {
  code: ExitCode;
  rows: string[];
  over: string[];
  blockers: string[];
  unrecorded: boolean;
}

/** The three judged ratios in one place: key, label, what a red one means. */
const METRICS = [
  { key: "heap", label: "heap", meaning: "something is retained cycle after cycle" },
  { key: "dom_nodes", label: "DOM nodes", meaning: "a subtree outlived its owner" },
  { key: "listeners", label: "listeners", meaning: "an effect subscribes and its cleanup stopped running" },
] as const;

/**
 * The judgement, pure: two objects in, one outcome out.
 *
 * Pure so it is falsifiable without a browser: `scripts/check-session-growth.test.ts`
 * feeds it synthetic measurements, including the ones that MUST come out red.
 */
export function judge(m: GrowthMeasure, b: GrowthBaseline, notBefore?: Date): GrowthOutcome {
  const rows: string[] = [];
  const over: string[] = [];
  const blockers: string[] = [];

  for (const { key, label, meaning } of METRICS) {
    const got = m.ratio[key];
    const max = b.budget[key];
    const within = typeof got === "number" && Number.isFinite(got) && got <= max;
    rows.push(
      `${within ? "  " : "! "}${label.padEnd(11)} x${String(got).padStart(7)}   budget x${max}`,
    );
    if (typeof got !== "number" || !Number.isFinite(got)) {
      // A ratio that is not a number is a bench that changed shape, not an app
      // that is flat. Silence here would be a permanent green.
      blockers.push(`the ratio \`${key}\` is not a number (${JSON.stringify(got)}): the bench wrote a shape this gate cannot read`);
      continue;
    }
    if (!within) over.push(`${key}: x${got} > x${max} (${meaning})`);
  }

  const g = b.guards;
  const w = m.witness;

  /**
   * A MISSING WITNESS ACCUSES, it does not stay silent. With the field absent,
   * `undefined < floor` is false, so no blocker and a green exit: renaming a
   * field in the spec would switch off the defence this gate claims as its own.
   */
  const numberOrNothing = (v: unknown, name: string): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    blockers.push(
      `the witness \`${name}\` is not a number (${JSON.stringify(v)}): without it there ` +
        `is no way to know the bench ran, and a ratio over an unknown run is not judged`,
    );
    return null;
  };

  const cycles = numberOrNothing(w?.cycles_completed, "cycles_completed");
  if (cycles !== null && cycles < g.cycles_completed_floor) {
    blockers.push(
      `${cycles} cycles completed < ${g.cycles_completed_floor}: a short run is flat by ` +
        `default, and a ratio taken over it proves nothing about a long session`,
    );
  }
  const reopened = numberOrNothing(w?.panes_reopened, "panes_reopened");
  if (reopened !== null && reopened < g.panes_reopened_floor) {
    blockers.push(
      `${reopened} panes reopened < ${g.panes_reopened_floor}: the mount and unmount half ` +
        `of the cycle did not happen, which is the half where leaks live`,
    );
  }
  const messages = numberOrNothing(w?.messages_streamed, "messages_streamed");
  if (messages !== null && messages < g.messages_streamed_floor) {
    blockers.push(`${messages} messages streamed < ${g.messages_streamed_floor}: the burst half of the cycle did not happen`);
  }
  if (w?.gc_forced !== true) {
    blockers.push(
      "the collection was never forced: without it the heap number is whatever V8 had " +
        "not bothered to reclaim, which moves by tens of megabytes between two identical states",
    );
  }
  const firstHeap = numberOrNothing(w?.first?.heap_bytes, "first.heap_bytes");
  if (firstHeap !== null && firstHeap < g.first_heap_bytes_floor) {
    blockers.push(
      `the first sample holds ${firstHeap} bytes < ${g.first_heap_bytes_floor}: a ratio over ` +
        `a denominator that small turns ordinary noise into a huge number`,
    );
  }
  const firstDom = numberOrNothing(w?.first?.dom_nodes, "first.dom_nodes");
  if (firstDom !== null && firstDom < g.first_dom_nodes_floor) {
    blockers.push(
      `the first sample counts ${firstDom} DOM nodes < ${g.first_dom_nodes_floor}: the app ` +
        `was not on screen when the baseline sample was taken`,
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

  const unrecorded = b.recorded !== true;
  const code: ExitCode = blockers.length > 0 ? 2 : unrecorded ? 2 : over.length > 0 ? 1 : 0;
  return { code, rows, over, blockers, unrecorded };
}

/**
 * The new budgets from a new measurement, with the rule declared in the baseline.
 *
 * The margin is ADDED and not multiplied: these are ratios near 1, and doubling
 * 1.02 would write a budget of 2.04, which is not a budget. The FLOOR keeps a
 * perfectly flat measurement from writing 1.00, which ordinary noise would break.
 */
export function updatedBudget(
  m: GrowthMeasure,
  b: GrowthBaseline,
): { heap: number; dom_nodes: number; listeners: number } {
  const one = (key: (typeof METRICS)[number]["key"]): number => {
    const rule = b.update_rule[key];
    if (!rule) return b.budget[key];
    return Math.max(rule.floor, Math.round((m.ratio[key] + rule.margin) * 100) / 100);
  };
  return { heap: one("heap"), dom_nodes: one("dom_nodes"), listeners: one("listeners") };
}

/** Defensive read: valid JSON with the wrong shape is not a measurement. */
export function readMeasure(path: string): GrowthMeasure {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GrowthMeasure>;
  if (!raw.ratio || !raw.witness) {
    throw new Error(`${path} does not have the shape of a measurement (ratio and witness are required).`);
  }
  return raw as GrowthMeasure;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 10_000) / 100} MB`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update-baseline");
  const fromAt = argv.indexOf("--from");
  const from = fromAt >= 0 ? argv[fromAt + 1] : undefined;
  if (fromAt >= 0 && !from) {
    console.error("check:growth - --from wants a path.");
    process.exit(2);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as GrowthBaseline;
  const outPath = from ? resolve(REPO_ROOT, from) : DEFAULT_OUT;
  let notBefore: Date | undefined;

  // Answered BEFORE the bench is spawned: this one takes about ten minutes, and
  // spending them to reach a verdict that is already known would be the fastest
  // way to get the step deleted. `--update-baseline` is the one flag that still
  // has to measure, because measuring is how the number gets recorded.
  if (!from && !update && baseline.recorded !== true) {
    console.error(
      `! BASELINE NEVER RECORDED, so there is nothing to judge and the bench is not run.\n` +
        `  The ratios in ${BASELINE_PATH} are a reading of the goal, not of this app.\n` +
        `  Record them on an idle machine and commit the diff:\n\n` +
        `      bun run check:growth -- --update-baseline\n`,
    );
    process.exit(2);
  }

  if (!from) {
    notBefore = new Date();
    console.log(`> measuring ${SPEC_PATH} (e2e bench, fifty cycles: allow ten minutes)\n`);
    const run = spawnSync("npx", ["playwright", "test", SPEC_PATH, "--reporter=list"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      // TOPICS_GROWTH_CYCLES and TOPICS_GROWTH_LEAK_NODES pass through untouched,
      // as do E2E_PORT and TOPICS_E2E_BUNDLE_DIR.
      env: { ...process.env, TOPICS_GROWTH_OUT: outPath },
    });
    if (run.status !== 0) {
      console.error(
        `\n! The bench did not finish (exit ${run.status}).\n` +
          `  This is not a verdict on growth: with no measurement there is nothing to judge.`,
      );
      process.exit(2);
    }
  }

  if (!existsSync(outPath)) {
    console.error(`! No measurement at ${outPath}.`);
    process.exit(2);
  }

  let measure: GrowthMeasure;
  try {
    measure = readMeasure(outPath);
  } catch (e) {
    console.error(`! ${(e as Error).message}`);
    process.exit(2);
  }

  const w = measure.witness;
  console.log("surface        chat panes, tab switching and streamed messages");
  console.log(
    `run            ${w.cycles_completed} cycles, ${w.panes_reopened} panes reopened, ` +
      `${w.messages_streamed} messages streamed`,
  );
  console.log(
    `cycle ${w.first?.cycle} .. ${w.last?.cycle}   heap ${mb(w.first?.heap_bytes ?? 0)} -> ${mb(w.last?.heap_bytes ?? 0)}, ` +
      `dom ${w.first?.dom_nodes} -> ${w.last?.dom_nodes}, listeners ${w.first?.listeners} -> ${w.last?.listeners}`,
  );
  if (measure.leak_injected_nodes) {
    console.log(
      `\n! LEAK INJECTED: ${measure.leak_injected_nodes} retained nodes per cycle.\n` +
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
      heap: measure.ratio.heap,
      dom_nodes: measure.ratio.dom_nodes,
      listeners: measure.ratio.listeners,
      retained_nodes: measure.ratio.retained_nodes ?? null,
      first_heap_bytes: w.first?.heap_bytes ?? null,
      first_dom_nodes: w.first?.dom_nodes ?? null,
      first_listeners: w.first?.listeners ?? null,
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
    console.error("\nNo verdict on growth: the measurement does not speak about the product.");
    process.exit(2);
  }

  if (outcome.unrecorded) {
    console.error(
      `\n! BASELINE NEVER RECORDED. The ratios in ${BASELINE_PATH} are a reading of the\n` +
        `  goal, not of this app: no run has ever written a real number there.\n` +
        `  Record it on an idle machine and commit the diff:\n\n` +
        `      bun run check:growth -- --update-baseline\n\n` +
        `  Exit 2, not 0: a budget that has never seen a real number cannot tell "flat"\n` +
        `  from "the bench measured nothing".`,
    );
    process.exit(2);
  }

  if (outcome.code === 1) {
    console.error(`\n! The session grows:\n  - ${outcome.over.join("\n  - ")}`);
    console.error(
      "\nWhere to look: listeners and DOM nodes point at a component whose cleanup stopped\n" +
        "running, or a subtree kept alive by a closure after its panel died. Heap alone,\n" +
        "with the other two flat, points at a store that appends and never trims. The\n" +
        `per-cycle curve is in the measurement JSON: a straight line is a leak, a step that\n` +
        `flattens is a cache. If the growth is deliberate, raise the number in\n` +
        `${BASELINE_PATH} IN THE SAME commit with the reason in \`budget_why\`.`,
    );
    process.exit(1);
  }

  console.log("\n> The session stays flat.");
  process.exit(0);
}
