/**
 * AI RESPONSE TIME — the shape of the record.
 *
 * The writer's half of the file `scripts/bench/ai-latency.ts` judges. Pure:
 * samples in, medians and the published JSON out, no browser and no
 * filesystem. It sits next to the judge because the two halves of
 * `bench/results/ai-latency-latest.json` are written and read three metres
 * apart, and because the interesting decision here — when a leg is "not
 * measured" instead of "fast" — is worth a unit test that runs in a
 * millisecond (`scripts/bench/ai-latency-shape.test.ts`) rather than only
 * inside a run that needs a server, a built bundle and a browser.
 *
 *   the probe (in-page)  tests/e2e/helpers/bench-ai-probe.ts
 *   the drive            tests/e2e/bench-ai-latency.spec.ts
 *   the shape (pure)     here
 *   the verdict (pure)   scripts/bench/ai-latency.ts
 */

export interface Measured {
  label: string;
  what: string;
  /** False means the number belongs to the provider and the network, not to this repo. */
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

export function summarise(label: string, what: string, ours: boolean, values: number[]): Measured {
  return {
    label,
    what,
    ours,
    measurable: true,
    unit: "ms",
    samples: values.map(round1),
    medianMs: round1(median(values)),
    minMs: round1(Math.min(...values)),
    maxMs: round1(Math.max(...values)),
  };
}

/** The median, which is what "how long does it usually take" means. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median: no samples");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ─────────────────────────────────────────────── the leg that is not ours ── */

const MODEL_LEG_LABEL = "accepted -> first provider event";
const MODEL_LEG_WHAT = "time the model and the network take before the first token exists";

export interface ModelLegInput {
  /** Whether a real provider was asked for at all (`BENCH_AI_REAL=1`). */
  real: boolean;
  /** Whether the probe turn actually reached a model. See `reachedAModel` in the spec. */
  modelIsReachable: boolean;
  /** What `stream:end` named on the probe turn. */
  probeModel: string | null;
  /** What `/api/providers/snapshot` claimed, for the message only. */
  providersReady: string[];
  /** The samples that were credited to the provider. Empty is a reason, not a zero. */
  samples: number[];
}

/**
 * The model's share, or a stated reason there is none.
 *
 * Four outcomes and never a zero: a leg that was not measured has to say so in
 * words, because "0 ms" reads as "instant" and the whole point of this bench is
 * that the model's time is not ours to publish.
 */
export function shapeModelLeg(i: ModelLegInput): Metric {
  const notMeasured = (reason: string): NotMeasured => ({
    label: MODEL_LEG_LABEL,
    what: MODEL_LEG_WHAT,
    ours: false,
    measurable: false,
    reason,
  });

  if (!i.real) {
    return notMeasured(
      "not measured by construction: the default mode never calls a model, so this leg is absent " +
        "rather than fast. Re-run with BENCH_AI_REAL=1 against a logged-in provider to measure it. " +
        "It belongs to the provider and the network and moves for reasons this repo does not control.",
    );
  }
  if (!i.modelIsReachable) {
    return notMeasured(
      "BENCH_AI_REAL=1 was requested and no model answered. The probe turn closed on model " +
        `"${i.probeModel ?? "none"}", which means the CLI was reached but never got to a provider. ` +
        `The snapshot's ready list (${i.providersReady.join(", ") || "empty"}) says configured, not logged in. ` +
        "Nothing was measured. This is not a zero.",
    );
  }
  if (i.samples.length === 0) {
    return notMeasured(
      `a model answered the probe turn (${i.probeModel}) but no measured sample produced a ` +
        "content chunk within the timeout. Nothing was measured. This is not a zero.",
    );
  }
  return summarise(MODEL_LEG_LABEL, MODEL_LEG_WHAT, false, i.samples);
}

/* ────────────────────────────────────────────────── the published record ── */

export interface AiLatencyReport {
  schema: "bench-ai-latency-v1";
  bench: "ai-latency";
  measured_at: string;
  mode: "real-provider" | "injected";
  platform: string;
  machine: string;
  shell: string;
  samples: { send: number; delivery: number };
  injected_stalls_ms: { send: number; deliver: number; accept: number };
  providers_reporting_ready: { names: string[]; what: string };
  models_that_answered: { seen: string[]; what: string };
  metrics: {
    composerToWire: Measured;
    wireToAccepted: Measured;
    firstTokenToInk: Measured;
    midStreamTokenToInk: Measured;
    acceptedToFirstProviderEvent: Metric;
  };
  request_body_chars: { median: number; min: number; max: number; budget: number; what: string };
  caveats: string[];
}

export interface AiLatencyReportInput {
  real: boolean;
  platform: string;
  machine: string;
  shell: string;
  samples: { send: number; delivery: number };
  stalls: { send: number; deliver: number; accept: number };
  providersReady: string[];
  /** One entry per send-leg turn: what `stream:end` said it ran on. */
  turnModels: string[];
  legs: {
    composerToWire: number[];
    wireToAccepted: number[];
    firstTokenToInk: number[];
    midStreamTokenToInk: number[];
  };
  modelLeg: Metric;
  bodyChars: number[];
  measuredAt?: Date;
}

/** The ceiling `REQUEST_TAIL_BUDGET_CHARS` in chatRequestPayload.ts is set to. */
const REQUEST_BODY_BUDGET_CHARS = 64 * 1024;

export function buildAiLatencyReport(input: AiLatencyReportInput): AiLatencyReport {
  return {
    schema: "bench-ai-latency-v1",
    bench: "ai-latency",
    measured_at: (input.measuredAt ?? new Date()).toISOString(),
    mode: input.real ? "real-provider" : "injected",
    platform: input.platform,
    machine: input.machine,
    shell: input.shell,
    samples: input.samples,
    injected_stalls_ms: input.stalls,
    providers_reporting_ready: {
      names: input.providersReady,
      what:
        "what /api/providers/snapshot claims. 'ready' means configured, not logged in: on the isolated " +
        "E2E server all three answer 'Not logged in'. Read models_that_answered instead.",
    },
    models_that_answered: {
      seen: Array.from(new Set(input.turnModels)),
      what:
        "the model named on stream:end for every send-leg turn. '<synthetic>' or 'none' means no model " +
        "was called and the run cost nothing. A real model id here means this run spent tokens.",
    },
    metrics: {
      composerToWire: summarise(
        "Enter -> request leaves the client",
        "composer handler, state update and the request body build",
        true,
        input.legs.composerToWire,
      ),
      wireToAccepted: summarise(
        "request leaves the client -> the turn exists",
        "in-flight gate, the SQLite write of the user row, the broadcast and one WebSocket hop back",
        true,
        input.legs.wireToAccepted,
      ),
      firstTokenToInk: summarise(
        "first provider event -> first token readable",
        "placeholder bubble, reducer, React and paint",
        true,
        input.legs.firstTokenToInk,
      ),
      midStreamTokenToInk: summarise(
        "mid-stream event -> that token readable",
        "the same path with the bubble already on screen, which is the one that runs hundreds of times a turn",
        true,
        input.legs.midStreamTokenToInk,
      ),
      acceptedToFirstProviderEvent: input.modelLeg,
    },
    request_body_chars: {
      median: Math.round(median(input.bodyChars)),
      min: Math.min(...input.bodyChars),
      max: Math.max(...input.bodyChars),
      budget: REQUEST_BODY_BUDGET_CHARS,
      what:
        "size of the POST /api/chat body in UTF-16 code units. The whole transcript used to travel on " +
        "every turn; today it is a BOUNDED tail, so within one run it still grows message by message " +
        "and then stops. The invariant is the ceiling (REQUEST_TAIL_BUDGET_CHARS in " +
        "client/src/hooks/chatRequestPayload.ts), not a constant.",
    },
    caveats: [
      "The four 'ours' intervals are never summed. They are separate paths and two of them overlap in " +
        "wall clock: the client is already painting its own bubble while the server is still writing the row.",
      "The shell is Chromium (Playwright), not the Tauri WKWebView the product ships. The paint legs are " +
        "Chromium paint legs.",
      "ink-latency.spec.ts measures a different thing on the same keystroke: Enter until the USER's own " +
        "message is readable, median 12.4 ms in tests/e2e/ink-budget.json. That bubble is painted " +
        "optimistically by the client and says nothing about the AI's answer.",
    ],
  };
}
