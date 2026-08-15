#!/usr/bin/env bun
/**
 * THE STREAMING BENCH — the reader.
 *
 *   bun run scripts/bench/streaming.ts                 measure, then report
 *   bun run scripts/bench/streaming.ts --on2 4         run it with the defect injected
 *   bun run scripts/bench/streaming.ts --from FILE     re-read a measurement
 *   bun run scripts/bench/streaming.ts --json          the verdict, machine-readable
 *
 * WHAT IT IS FOR. This is a REPORT, not a gate: the numbers are meant to be
 * published, so the interesting output is the table, not the exit code. But a
 * bench that cannot fail is a bench nobody has to keep honest, so it does have
 * one claim it will go red on, and exactly one:
 *
 *   THE COST OF A CHUNK MUST NOT KNOW HOW LONG THE CONVERSATION IS.
 *
 * That is the claim behind the three changes that landed on the streaming path
 * in August 2026 (tool-run coalescing, the rAF buffer for `stream:tool_update`,
 * the live-tail/settled-prefix split in `MessageList`), and it is the one thing
 * a reader of the published table is entitled to trust. The measurement drives
 * the same burst into a 6-message transcript and a 2000-message one; if the
 * long one costs materially more per chunk, that is the defect, and this
 * command says so.
 *
 * WHERE EACH PIECE LIVES.
 *   the probe + the drive   tests/e2e/bench-streaming.spec.ts
 *   the measurement         test-results/bench-streaming.json
 *   the thresholds          `LIMITS` below, each with its reason next to it
 *   the verdict             `judge()` below, pure, unit-tested without a browser
 *
 * THREE EXIT CODES, and the distinction is the whole point:
 *   0  measured, and the cost of a chunk is independent of transcript length
 *   1  REGRESSION: it is not, or something outside the message list is moving
 *      because of the stream
 *   2  NOT MEASURABLE: no measurement, a witness missing, a ratio with a zero
 *      under it, a measurement older than the run. A command that reports 2 as
 *      0 is worse than no command, because it is a green nobody earned.
 *
 * HOW TO SEE IT GO RED. `--on2 4` makes the client burn 4 µs per transcript
 * message inside the task that parses each arriving chunk — 8 ms a chunk on the
 * 2000-message thread, and nothing at all on the 6-message one. That is the
 * defect this axis exists to catch, injected into the real main thread.
 * Lowering a threshold would only prove that `>` works.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SPEC = "tests/e2e/bench-streaming.spec.ts";
const DEFAULT_OUT = join(REPO_ROOT, "test-results/bench-streaming.json");

/* ──────────────────────────────────────────────────────── the measurement ── */

export interface ScenarioMedian {
  /** Where the chunk counter stood when the burst closed. */
  applied_at_end: number;
  /** Chunks that actually landed. Below `chunks_per_burst` means the client fell behind. */
  chunks_absorbed: number;
  /** 1 when the burst closed on the deadline instead of on the target. */
  fell_behind: number;
  absorbed_per_s: number;
  handoff_per_s: number;
  drain_ms: number;
  absorb_ms: number;
  cost_us_per_chunk: number;
  busy_ms: number;
  busy_us_per_chunk: number;
  blocked_ms: number;
  longtask_count: number;
  longtask_ms: number;
  loaf_count: number;
  loaf_script_ms: number;
  loaf_blocking_ms: number;
  frames: number;
  worst_gap_ms: number;
  median_gap_ms: number;
  layout_shift_outside_list: number;
  layout_shift_inside_list: number;
  mutations_outside_list: number;
}

export interface Scenario {
  mode: "text" | "tool";
  transcript: "short" | "long";
  transcript_messages: number;
  chunks_per_burst: number;
  reps: number;
  median: ScenarioMedian;
  loaf_supported: boolean;
  outside_movers: string[];
}

export interface QuietBaseline {
  window_ms: number;
  frames: number;
  mutations_outside_list: number;
  layout_shift_outside_list: number;
  busy_ms: number;
  outside_movers: string[];
}

export interface StreamMeasurement {
  measured_at?: string;
  machine?: { platform?: string; arch?: string; cpu?: string; cores?: number };
  knob?: { on2_us_per_message?: number };
  protocol?: Record<string, unknown>;
  witness?: Record<string, number>;
  quiet_baseline?: Record<string, QuietBaseline>;
  scenarios?: Record<string, Scenario>;
  cost_of_length?: Record<string, number | null>;
}

/* ───────────────────────────────────────────────────────────── the limits ── */

export interface Limit {
  max: number;
  why: string;
}

/**
 * THE THRESHOLDS, AND WHY EACH ONE IS THAT NUMBER.
 *
 * They live in code and not in a JSON file on purpose. This is a report: there
 * is no baseline to re-record after every machine change, and a number whose
 * reason sits three files away from it is a number the next person raises
 * without asking what it bought.
 */
export const LIMITS: Record<string, Limit> = {
  cost_ratio: {
    max: 1.5,
    why:
      "Long transcript over short, per chunk. A client that pays per chunk lands at " +
      "1.0; measured 1.00–1.03 across text and tool on an M-series laptop. 1.5 is " +
      "generous enough to survive a noisy machine and far below what an O(N) " +
      "per-chunk pass produces (2000/6 = 333x in principle, ~20x with the knob at 4 µs).",
  },
  busy_ratio: {
    max: 1.6,
    why:
      "The same claim read off the main thread instead of the wall clock. Slightly " +
      "looser than the wall-clock ratio because busy time is a rate deficit and " +
      "carries the probe's own scheduling noise; measured 1.01–1.03.",
  },
  layout_shift_outside_list: {
    max: 0.02,
    why:
      "The product goal says streaming must not cause layout or reflow outside the " +
      "message area. Measured 0.0 on every scenario. The allowance is not for the " +
      "stream: it is for what the quiet baseline shows moving anyway (the sidebar " +
      "device readout re-flows on its own timer), and the quiet number is " +
      "SUBTRACTED before this limit is applied.",
  },
};

/**
 * A client that never fell behind cannot report a ceiling.
 *
 * When the driver stops and the page is caught up within a few frames, the
 * absorbed rate is a FLOOR on what the client can take, not a limit it hit —
 * the harness ran out of frames first. Saying otherwise would publish the
 * driver's speed as the product's.
 */
export const HARNESS_BOUND_DRAIN_MS = 50;

/* ────────────────────────────────────────────────────────────── the judge ── */

export type ExitCode = 0 | 1 | 2;

export interface Verdict {
  code: ExitCode;
  /** The table, always printed, whatever the code. */
  rows: string[];
  /** What broke the claim. Empty unless the code is 1. */
  exceeded: string[];
  /** Why the measurement cannot be judged. Empty unless the code is 2. */
  blockers: string[];
  /** Things a reader should know that are not failures. */
  notes: string[];
}

const PAIRS = [
  { mode: "text", label: "text deltas" },
  { mode: "tool", label: "tool output" },
] as const;

/**
 * Pure: a measurement in, a verdict out. No browser, no filesystem.
 *
 * `notBefore`, when given, is the instant this run started: a measurement older
 * than that is a leftover artefact, and judging it would hand a green to code
 * that was never exercised.
 */
export function judge(m: StreamMeasurement, notBefore?: Date): Verdict {
  const rows: string[] = [];
  const exceeded: string[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];

  const scenarios = m.scenarios ?? {};
  const witness = m.witness ?? {};
  const quiet = m.quiet_baseline ?? {};

  if (!m.measured_at) {
    blockers.push(
      "the measurement carries no `measured_at`: there is no way to say whether it " +
        "belongs to this run or to a previous one",
    );
  } else if (notBefore && new Date(m.measured_at) < notBefore) {
    blockers.push(
      `the measurement is from ${m.measured_at}, i.e. BEFORE this run started: it is ` +
        "an artefact of an earlier one and says nothing about the code as it is now",
    );
  }

  // THE WITNESSES. A bench whose long transcript was not long compares a thing
  // against itself and reports 1.0 forever.
  const longMessages = witness.long_transcript_messages;
  const shortMessages = witness.short_transcript_messages;
  if (typeof longMessages !== "number" || typeof shortMessages !== "number") {
    blockers.push(
      "the transcript-length witnesses are missing: without them nobody knows the two " +
        "sides of the ratio were different lengths at all",
    );
  } else if (longMessages < shortMessages * 20) {
    blockers.push(
      `the long transcript (${longMessages}) is not meaningfully longer than the control ` +
        `(${shortMessages}): the ratio would be 1.0 whatever the client did`,
    );
  }
  if (typeof witness.long_scroll_run_px !== "number" || witness.long_scroll_run_px <= 0) {
    blockers.push(
      "the long transcript produced no scroll run: the client did not actually hold the " +
        "whole thread, so the expensive side of the comparison was never expensive",
    );
  }

  for (const { mode, label } of PAIRS) {
    const long = scenarios[`${mode}_long`];
    const short = scenarios[`${mode}_short`];
    if (!long || !short) {
      blockers.push(`${label}: one of the two transcripts was never measured`);
      rows.push(`${pad(label, 14)}  —  not measured`);
      continue;
    }

    const costRatio = ratio(long.median.cost_us_per_chunk, short.median.cost_us_per_chunk);
    const busyRatio = ratio(long.median.busy_us_per_chunk, short.median.busy_us_per_chunk);
    if (costRatio === null) {
      blockers.push(
        `${label}: the short transcript cost 0 µs a chunk, so the ratio has a zero under ` +
          "it. That is an unreadable measurement, not a perfect one",
      );
    }

    rows.push(
      `${pad(label, 14)}${pad(`${fmt(short.median.cost_us_per_chunk)} µs`, 12)}` +
        `${pad(`${fmt(long.median.cost_us_per_chunk)} µs`, 12)}` +
        `${pad(costRatio === null ? "n/a" : `${fmt(costRatio)}x`, 9)}` +
        `${pad(`${fmt(short.median.absorbed_per_s)}/s`, 12)}` +
        `${pad(`${fmt(long.median.absorbed_per_s)}/s`, 12)}` +
        (costRatio !== null && costRatio > LIMITS.cost_ratio.max ? "OVER" : "ok"),
    );

    // FELL BEHIND IS THE THROUGHPUT ANSWER, and it belongs in the table.
    // "Chunks per second before it falls behind" is only a real number when
    // something fell behind; when nothing did, the honest report is that the
    // driver ran out first (the note below), not a ceiling nobody hit.
    for (const s of [short, long]) {
      if (s.median.fell_behind >= 1) {
        notes.push(
          `${label} (${s.transcript}): the client did NOT keep up — ${fmt(s.median.chunks_absorbed)} ` +
            `of ${s.chunks_per_burst} chunks landed before the burst deadline, i.e. ` +
            `${fmt(s.median.absorbed_per_s)} chunks a second is its ceiling on this transcript`,
        );
      }
    }

    if (costRatio !== null && costRatio > LIMITS.cost_ratio.max) {
      exceeded.push(
        `${label}: a chunk costs ${fmt(costRatio)}x more in a ${long.transcript_messages}-message ` +
          `thread than in a ${short.transcript_messages}-message one ` +
          `(${fmt(long.median.cost_us_per_chunk)} µs vs ${fmt(short.median.cost_us_per_chunk)} µs, ` +
          `limit ${LIMITS.cost_ratio.max}x)`,
      );
    }
    if (busyRatio !== null && busyRatio > LIMITS.busy_ratio.max) {
      exceeded.push(
        `${label}: the main thread spends ${fmt(busyRatio)}x longer per chunk in the long ` +
          `thread (${fmt(long.median.busy_us_per_chunk)} µs vs ` +
          `${fmt(short.median.busy_us_per_chunk)} µs, limit ${LIMITS.busy_ratio.max}x)`,
      );
    }

    // Layout outside the message area, with the wall clock subtracted.
    for (const s of [short, long]) {
      const base = quiet[s.transcript];
      const seconds = s.median.absorb_ms / 1000;
      const baselineShift =
        base && base.window_ms > 0 ? (base.layout_shift_outside_list / base.window_ms) * 1000 * seconds : 0;
      const attributable = s.median.layout_shift_outside_list - baselineShift;
      if (attributable > LIMITS.layout_shift_outside_list.max) {
        exceeded.push(
          `${label} (${s.transcript}): ${fmt4(attributable)} of layout shift outside the message ` +
            `list is attributable to the stream (limit ${LIMITS.layout_shift_outside_list.max}); ` +
            `movers: ${s.outside_movers.join(", ") || "unattributed"}`,
        );
      }
    }

    if (long.median.drain_ms < HARNESS_BOUND_DRAIN_MS) {
      notes.push(
        `${label}: the client was caught up ${fmt(long.median.drain_ms)} ms after the driver ` +
          `stopped, so ${fmt(long.median.absorbed_per_s)}/s is a FLOOR on what it can take — ` +
          "the harness ran out of frames before the client ran out of headroom",
      );
    } else {
      notes.push(
        `${label}: ${fmt(long.median.drain_ms)} ms of backlog remained when the driver stopped — ` +
          `${fmt(long.median.absorbed_per_s)}/s is the client's own ceiling here`,
      );
    }

    if (!long.loaf_supported) {
      notes.push(`${label}: long-animation-frame timing not available here — scripting time not measured`);
    }
    const moversLong = long.outside_movers.filter((x) => x.startsWith("dom "));
    if (moversLong.length > 0) {
      notes.push(
        `${label}: DOM outside the list changed ${long.median.mutations_outside_list} times over ` +
          `${long.chunks_per_burst} chunks — ${moversLong.join(", ")} ` +
          `(quiet baseline: ${quiet[long.transcript]?.mutations_outside_list ?? "n/a"} in ` +
          `${quiet[long.transcript]?.window_ms ?? "n/a"} ms of silence)`,
      );
    }
  }

  // A blocker outranks an overrun: a red on a measurement that does not count
  // is still a statement about nothing.
  const code: ExitCode = blockers.length > 0 ? 2 : exceeded.length > 0 ? 1 : 0;
  return { code, rows, exceeded, blockers, notes };
}

/** `null`, never 0, when the denominator is 0 — see the note in the spec. */
export function ratio(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round((a / b) * 100) / 100;
}

/** Defensive read: valid JSON in the wrong shape is not a measurement. */
export function readMeasurement(path: string): StreamMeasurement {
  const raw = JSON.parse(readFileSync(path, "utf8")) as StreamMeasurement;
  if (!raw.scenarios || !raw.witness) {
    throw new Error(`${path} does not have the shape of a streaming measurement (scenarios, witness).`);
  }
  return raw;
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s} ` : s + " ".repeat(n - s.length);
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function fmt4(n: number): string {
  return String(Math.round(n * 10_000) / 10_000);
}

/* ───────────────────────────────────────────────────────────────── the cli ── */

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const fromAt = argv.indexOf("--from");
  const from = fromAt >= 0 ? argv[fromAt + 1] : undefined;
  const on2At = argv.indexOf("--on2");
  const on2 = on2At >= 0 ? Number(argv[on2At + 1]) : 0;

  if (fromAt >= 0 && !from) {
    console.error("bench:streaming — --from wants a path.");
    process.exit(2);
  }
  if (on2At >= 0 && (!Number.isFinite(on2) || on2 <= 0)) {
    console.error("bench:streaming — --on2 wants a positive number of microseconds per message.");
    process.exit(2);
  }

  const outPath = from ? resolve(REPO_ROOT, from) : DEFAULT_OUT;
  let notBefore: Date | undefined;

  if (!from) {
    notBefore = new Date();
    console.log(
      on2 > 0
        ? `▸ measuring ${SPEC} WITH ${on2} µs of per-chunk work per transcript message injected\n`
        : `▸ measuring ${SPEC} (e2e bench, a few minutes)\n`,
    );
    // Typed as a plain string map on purpose: spreading `process.env` gives it
    // the shape of the CURRENT environment, so assigning a variable that does not
    // happen to be set on this machine is a type error rather than the ordinary
    // act of passing one to a child.
    const env: Record<string, string | undefined> = { ...process.env, TOPICS_BENCH_STREAM_OUT: outPath };
    if (on2 > 0) env.TOPICS_STREAM_ON2_US_PER_MSG = String(on2);
    const run = spawnSync("npx", ["playwright", "test", SPEC, "--reporter=line"], {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
    });
    if (run.status !== 0) {
      console.error(
        `\n✗ The bench did not finish (playwright exit ${run.status}).\n` +
          "  Nothing was measured, so nothing is being judged. This is a 2, not a red.",
      );
      process.exit(2);
    }
  }

  if (!existsSync(outPath)) {
    console.error(`✗ No measurement at ${outPath}.`);
    process.exit(2);
  }

  let measurement: StreamMeasurement;
  try {
    measurement = readMeasurement(outPath);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(2);
  }

  const verdict = judge(measurement, notBefore);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          exit_code: verdict.code,
          measured_at: measurement.measured_at,
          machine: measurement.machine,
          knob: measurement.knob,
          cost_of_length: measurement.cost_of_length,
          exceeded: verdict.exceeded,
          blockers: verdict.blockers,
          notes: verdict.notes,
        },
        null,
        2,
      ),
    );
    process.exit(verdict.code);
  }

  const machine = measurement.machine ?? {};
  const protocol = measurement.protocol ?? {};
  console.log("\nSTREAMING — what one arriving chunk costs");
  console.log(`machine    ${machine.cpu ?? "unknown"} · ${machine.cores ?? "?"} cores · ${machine.platform ?? "?"}`);
  console.log(
    `protocol   ${protocol.chunks_per_burst ?? "?"} chunks x ${protocol.reps ?? "?"} bursts · ` +
      `${protocol.short_transcript_messages ?? "?"} vs ${protocol.long_transcript_messages ?? "?"} messages`,
  );
  console.log(`measured   ${measurement.measured_at ?? "unknown"}`);
  if ((measurement.knob?.on2_us_per_message ?? 0) > 0) {
    console.log(
      `\n⚠ DEFECT INJECTED: ${measurement.knob?.on2_us_per_message} µs of work per transcript ` +
        "message, on every chunk.\n" +
        "  This measurement exists to watch the bench fail. It is not a reading of the repo.",
    );
  }
  console.log("");
  console.log(
    `${pad("", 14)}${pad("short", 12)}${pad("long", 12)}${pad("ratio", 9)}` +
      `${pad("short", 12)}${pad("long", 12)}`,
  );
  console.log(
    `${pad("", 14)}${pad("µs/chunk", 12)}${pad("µs/chunk", 12)}${pad(`≤${LIMITS.cost_ratio.max}x`, 9)}` +
      `${pad("absorbed", 12)}${pad("absorbed", 12)}`,
  );
  for (const r of verdict.rows) console.log(r);

  if (verdict.notes.length > 0) {
    console.log("\nnotes:");
    for (const n of verdict.notes) console.log(`  · ${n}`);
  }

  if (verdict.code === 2) {
    console.error(`\n✗ MEASUREMENT UNUSABLE:\n  - ${verdict.blockers.join("\n  - ")}`);
    console.error("\nNo verdict on streaming: the measurement does not describe the product.");
    process.exit(2);
  }
  if (verdict.code === 1) {
    console.error(`\n✗ The cost of a chunk now depends on the transcript:\n  - ${verdict.exceeded.join("\n  - ")}`);
    console.error(
      "\nWhere to look: the three places that exist to keep this flat are " +
        "`coalesceToolRuns` (fusing settled tool runs once, not per frame), `bufferToolUpdate` " +
        "(one flush per animation frame instead of one per line of output), and the " +
        "live-tail/settled-prefix split in `MessageList.tsx` (the settled array must keep its " +
        "identity while the tail grows). A regression here is almost always a memo whose input " +
        "array is freshly allocated on every chunk.",
    );
    process.exit(1);
  }

  console.log("\n✓ The cost of a chunk does not depend on how long the conversation is.");
  process.exit(0);
}
