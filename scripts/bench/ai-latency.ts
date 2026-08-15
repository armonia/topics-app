#!/usr/bin/env bun
/**
 * AI RESPONSE TIME, as a gate.
 *
 * Topics has no model. It drives Claude Code, Codex and other CLI agents over a
 * PTY, so "how fast is the AI" is a question about somebody else's product.
 * Publishing one number for it under our name would be publishing somebody
 * else's latency. What IS ours is the overhead we add on that path, and this
 * script prints it split into the four intervals that a user actually feels,
 * with the model's share reported separately and labelled as not ours.
 *
 *   send    Enter                    -> the POST leaves the client
 *   accept  the POST                 -> the turn exists, confirmed back over WS
 *   first   a provider event arrives -> the first token is READABLE
 *   mid     a later provider event   -> that token is readable
 *   model   the turn is accepted     -> the provider's first token exists
 *           NOT OURS. Absent unless somebody asks for it with --real.
 *
 * The four are never added together. Two of them overlap in wall clock: the
 * client is already painting while the server is still writing the row. A total
 * would be a number that no clock ever measured.
 *
 * WHERE EACH PIECE LIVES.
 *   the measurement  tests/e2e/bench-ai-latency.spec.ts   (drives the app, writes the JSON)
 *   the result       bench/results/ai-latency-latest.json
 *   the verdict      here
 *
 * The spec deliberately asserts no threshold, for the reason
 * scripts/check-ink-latency.ts gives: one number judged in two places is how a
 * budget ends up with two values.
 *
 * COST. The default mode calls no model, and it does not merely intend to: the
 * spec records the model named on every `stream:end`, so a run that DID reach a
 * provider says so in its own output and this script prints it. On the isolated
 * E2E server the CLI has its own HOME and is not logged in, so every turn closes
 * on `<synthetic>`.
 *
 * USAGE
 *   bun run scripts/bench/ai-latency.ts                   measure, then judge
 *   bun run scripts/bench/ai-latency.ts --no-run          judge the last measurement again
 *   bun run scripts/bench/ai-latency.ts --stall-send 150     falsification: our send path
 *   bun run scripts/bench/ai-latency.ts --stall-deliver 120  falsification: our delivery path
 *   bun run scripts/bench/ai-latency.ts --stall-accept 150   falsification: the request in flight
 *   bun run scripts/bench/ai-latency.ts --real            ALSO measure the model's share,
 *                                                         against a real provider, for real money
 *
 * The measurement runs against the isolated E2E server the Playwright
 * globalSetup starts, so it needs a built client bundle exactly like the rest of
 * the suite: `bun run build:client`, or point TOPICS_E2E_BUNDLE_DIR at a bundle
 * built elsewhere. E2E_PORT is honoured when set.
 *
 * EXIT CODES
 *   0  everything inside budget
 *   1  something over budget
 *   2  nothing to judge (the measurement did not run, or its file is unreadable)
 *   3  --real was asked for and the model's share was not measurable
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const SPEC = "tests/e2e/bench-ai-latency.spec.ts";
const RESULT_PATH = join(REPO_ROOT, "bench/results/ai-latency-latest.json");

// ------------------------------------------------------------------ budget --

export interface Budget {
  medianMs: number;
  maxMs: number;
}

export interface Leg {
  key: string;
  /** How it reads in the table. */
  label: string;
  /** What the interval ends at, in the user's terms. */
  answer: string;
  budget: Budget;
}

/**
 * THE BUDGET LIVES HERE, in one place, and this script is its only reader.
 *
 * It is not in a JSON file next to tests/e2e/ink-budget.json only because this
 * harness was delivered as three files and a fourth would have been outside its
 * scope. Moving it to bench/ai-latency-budget.json is a mechanical change and
 * loses nothing, as long as it stays a SINGLE copy.
 *
 * Baseline, measured 2026-08-15 on an Apple M2 Max (12 cores, darwin 25.2.0),
 * headless Chromium 1280x800, isolated test server, 7 samples per leg, four
 * consecutive runs:
 *
 *   send    median 0.2 ms   (0.2 - 0.7)
 *   accept  median 9.7 ms   (7.0 - 15.8)
 *   first   median 16.2 ms  (12.4 - 27.6)
 *   mid     median 20.0 ms  (17.8 - 29.1)
 *
 * WHY THE NUMBERS ARE NOT FITTED TO THAT. A budget fitted to today's median has
 * to be re-fitted on every machine, and turns ordinary scheduling noise into
 * red. Each one below is a number with a reason:
 *
 *   send:   the request build is not supposed to be work. 5 ms is 25x today and
 *           still an order of magnitude below "the user noticed". The defect
 *           this leg was written after is not really a duration though, it is a
 *           SIZE, so the real gate on it is `requestBodyChars` below.
 *   accept: a SQLite insert plus one loopback WebSocket hop. 40 ms is 4x today,
 *           loose enough to survive a loaded machine, tight enough that a
 *           synchronous fsync or a table scan on the send path cannot hide.
 *   first / mid: the SAME pair of numbers as tests/e2e/ink-budget.json, on
 *           purpose. They end at the same kind of event that budget ends at, a
 *           frame with the answer painted in it, and 100 ms is the ceiling under
 *           which a response reads as instantaneous rather than as a delay.
 *           Inventing a second pair for the same class of event is how one
 *           threshold becomes two.
 *
 * The max exists because the median cannot see it: the defect ink-budget.json
 * was written after was one sample at 196 ms among four at 13 ms.
 */
export const LEGS: Leg[] = [
  {
    key: "composerToWire",
    label: "send (ours)",
    answer: "the POST has left the client",
    budget: { medianMs: 5, maxMs: 25 },
  },
  {
    key: "wireToAccepted",
    label: "accept (ours)",
    answer: "the server has the turn and said so",
    budget: { medianMs: 40, maxMs: 120 },
  },
  {
    key: "firstTokenToInk",
    label: "first token (ours)",
    answer: "the first token is readable",
    budget: { medianMs: 100, maxMs: 250 },
  },
  {
    key: "midStreamTokenToInk",
    label: "mid-stream (ours)",
    answer: "a later token is readable",
    budget: { medianMs: 100, maxMs: 250 },
  },
];

/** The model's share. Reported, never judged: it is not ours to defend. */
export const MODEL_LEG_KEY = "acceptedToFirstProviderEvent";

/**
 * The ceiling on the request body, in UTF-16 code units.
 *
 * This is the leg's real gate, and it is deliberately the CONSTANT that causes
 * the number rather than a stopwatch reading, the way ink-budget.json says an
 * excluded cost would have to be gated. `REQUEST_TAIL_BUDGET_CHARS` in
 * client/src/hooks/chatRequestPayload.ts is 64 KB; if it changes, this changes
 * with it by construction. The whole transcript used to travel on every turn,
 * which is a defect a millisecond reading would barely notice on a short chat
 * and would scream about only once somebody's conversation got long.
 */
export const REQUEST_BODY_CHARS_CEILING = 64 * 1024;

// -------------------------------------------------------------- the result --

export interface Measured {
  label: string;
  what: string;
  ours: boolean;
  measurable: true;
  unit: "ms";
  samples: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface NotMeasured {
  label: string;
  what: string;
  ours: boolean;
  measurable: false;
  reason: string;
}

export type Metric = Measured | NotMeasured;

export interface BenchResult {
  measured_at: string;
  mode: string;
  machine: string;
  shell: string;
  samples: { send: number; delivery: number };
  injected_stalls_ms: { send: number; deliver: number; accept: number };
  models_that_answered: { seen: string[] };
  metrics: Record<string, Metric>;
  request_body_chars: { median: number; min: number; max: number };
}

export interface Verdict {
  rows: string[];
  failures: string[];
  /** Lines that belong under the table: what is not ours, what this run cost. */
  notes: string[];
  exitCode: 0 | 1 | 2 | 3;
}

// -------------------------------------------------------------- the verdict --

/**
 * Read one result and decide. Pure, so scripts/bench/ai-latency.test.ts can put
 * a made-up result in front of it and check that it goes red for the right
 * reason instead of checking that `>` works.
 */
export function judge(result: BenchResult, opts: { real: boolean } = { real: false }): Verdict {
  const rows: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];

  for (const leg of LEGS) {
    const metric = result.metrics[leg.key];
    if (!metric) {
      failures.push(`${leg.label}: not measured at all`);
      rows.push(`${pad(leg.label, 20)}  not measured`);
      continue;
    }
    if (!metric.measurable) {
      failures.push(`${leg.label}: ${metric.reason}`);
      rows.push(`${pad(leg.label, 20)}  not measured`);
      continue;
    }
    const overMedian = metric.medianMs > leg.budget.medianMs;
    const overMax = metric.maxMs > leg.budget.maxMs;
    rows.push(
      pad(leg.label, 20) +
        pad(`${metric.medianMs} ms`, 11) +
        pad(`(${metric.minMs} - ${metric.maxMs})`, 18) +
        pad(`<= ${leg.budget.medianMs}/${leg.budget.maxMs}`, 13) +
        (overMedian || overMax ? "FAIL" : "ok  ") +
        `   -> ${leg.answer}`,
    );
    if (overMedian) {
      failures.push(
        `${leg.label}: ${metric.medianMs} ms median, budget ${leg.budget.medianMs} ms ` +
          `(samples ${metric.samples.join(", ")})`,
      );
    }
    if (overMax) {
      failures.push(
        `${leg.label}: one sample at ${metric.maxMs} ms, ceiling ${leg.budget.maxMs} ms ` +
          `(samples ${metric.samples.join(", ")})`,
      );
    }
  }

  // The request body: a size, not a duration, and the sharper of the two
  // instruments for the send path.
  const body = result.request_body_chars;
  const bodyOver = body.max > REQUEST_BODY_CHARS_CEILING;
  rows.push(
    pad("request body", 20) +
      pad(`${body.median} ch`, 11) +
      pad(`(${body.min} - ${body.max})`, 18) +
      pad(`<= ${REQUEST_BODY_CHARS_CEILING}`, 13) +
      (bodyOver ? "FAIL" : "ok  ") +
      "   -> what one send puts on the wire",
  );
  if (bodyOver) {
    failures.push(
      `request body: ${body.max} characters, ceiling ${REQUEST_BODY_CHARS_CEILING}. ` +
        "The tail budget in client/src/hooks/chatRequestPayload.ts is not holding.",
    );
  }

  // The model's share. Printed, never judged.
  const model = result.metrics[MODEL_LEG_KEY];
  if (model && model.measurable) {
    rows.push(
      pad("model (NOT ours)", 20) +
        pad(`${model.medianMs} ms`, 11) +
        pad(`(${model.minMs} - ${model.maxMs})`, 18) +
        pad("no budget", 13) +
        "    " +
        "   -> the provider produced its first token",
    );
    notes.push(
      "The model line belongs to the provider and the network. It has no budget here and it moves for " +
        "reasons this repo does not control.",
    );
  } else {
    rows.push(`${pad("model (NOT ours)", 20)}  not measured`);
    notes.push(`Model share not measured: ${model && !model.measurable ? model.reason : "no entry in the result."}`);
  }

  let exitCode: Verdict["exitCode"] = failures.length > 0 ? 1 : 0;
  if (opts.real && (!model || !model.measurable)) {
    // Asking for the model's share and getting nothing is its own outcome. It is
    // not a pass, and it must never be reported as a zero.
    exitCode = 3;
  }

  const spent = result.models_that_answered.seen.filter((m) => m.length > 0 && !m.startsWith("<") && m !== "none");
  notes.push(
    spent.length > 0
      ? `This run CALLED a model: ${spent.join(", ")}. It cost tokens.`
      : "This run called no model. Every turn closed on a synthetic reply, so it cost nothing.",
  );

  const stalls = result.injected_stalls_ms;
  if (stalls.send > 0 || stalls.deliver > 0 || stalls.accept > 0) {
    notes.push(
      `FALSIFICATION RUN: injected stalls of send ${stalls.send} ms, deliver ${stalls.deliver} ms, ` +
        `accept ${stalls.accept} ms. These numbers are supposed to be bad.`,
    );
  }

  return { rows, failures, notes, exitCode };
}

export function renderReport(result: BenchResult, verdict: Verdict): string {
  const out: string[] = [];
  out.push("");
  out.push("AI RESPONSE TIME: what Topics adds, split from what the model takes");
  out.push(
    `${result.samples.send} send samples, ${result.samples.delivery} delivery samples · ` +
      `mode ${result.mode} · measured ${result.measured_at}`,
  );
  out.push(`${result.machine} · ${result.shell}`);
  out.push("");
  for (const row of verdict.rows) out.push("  " + row);
  out.push("");
  for (const note of verdict.notes) out.push("  " + note);
  return out.join("\n");
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

// ------------------------------------------------------------------- runner --

interface Args {
  noRun: boolean;
  real: boolean;
  stallSendMs: number;
  stallDeliverMs: number;
  stallAcceptMs: number;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const num = (flag: string): number | { error: string } => {
    const at = argv.indexOf(flag);
    if (at < 0) return 0;
    const value = Number(argv[at + 1]);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `${flag} wants a positive number of milliseconds` };
    }
    return value;
  };
  const send = num("--stall-send");
  const deliver = num("--stall-deliver");
  const accept = num("--stall-accept");
  for (const v of [send, deliver, accept]) if (typeof v !== "number") return v;
  return {
    noRun: argv.includes("--no-run"),
    real: argv.includes("--real"),
    stallSendMs: send as number,
    stallDeliverMs: deliver as number,
    stallAcceptMs: accept as number,
  };
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`bench:ai-latency - ${parsed.error}`);
    return 2;
  }

  if (!parsed.noRun) {
    const env = { ...process.env };
    if (parsed.stallSendMs > 0) env.BENCH_AI_SEND_STALL_MS = String(parsed.stallSendMs);
    if (parsed.stallDeliverMs > 0) env.BENCH_AI_DELIVER_STALL_MS = String(parsed.stallDeliverMs);
    if (parsed.stallAcceptMs > 0) env.BENCH_AI_ACCEPT_STALL_MS = String(parsed.stallAcceptMs);
    if (parsed.real) env.BENCH_AI_REAL = "1";
    console.log(
      parsed.real
        ? "Measuring, WITH a real provider for the model leg. This spends tokens."
        : "Measuring. No model is called.",
    );
    const run = spawnSync("npx", ["playwright", "test", SPEC, "--reporter=dot"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (run.status !== 0) {
      console.error(
        `\nbench:ai-latency - the measurement did not complete (playwright exit ${run.status}).\n` +
          "Nothing was measured, so nothing is being judged. This is a red, not a pass.",
      );
      return 2;
    }
  }

  if (!existsSync(RESULT_PATH)) {
    console.error(`bench:ai-latency - no measurement at ${RESULT_PATH}. Run without --no-run.`);
    return 2;
  }
  const result = JSON.parse(readFileSync(RESULT_PATH, "utf8")) as BenchResult;
  const verdict = judge(result, { real: parsed.real });
  console.log(renderReport(result, verdict));

  if (verdict.failures.length > 0) {
    console.error("\nOver budget:");
    for (const f of verdict.failures) console.error("  · " + f);
  } else if (verdict.exitCode === 0) {
    console.log("\nEverything ours is inside budget.");
  }
  if (verdict.exitCode === 3) {
    console.error("\n--real was asked for and the model's share was not measurable. Not a pass, and not a zero.");
  }
  return verdict.exitCode;
}

// Guarded so scripts/bench/ai-latency.test.ts can import the pure half without
// the module exiting the test runner on import.
if (import.meta.main) process.exit(main());
