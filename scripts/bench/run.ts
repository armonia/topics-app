#!/usr/bin/env bun
/**
 * THE BENCH RUNNER.
 *
 *   bun run bench                          collect, print the table, write the JSON
 *   bun run bench -- --update-readme       and refresh the table inside bench/README.md
 *   bun run bench -- --max-age-days 30     exit 1 if any published number is older
 *   bun run bench -- --require-all         exit 1 if a declared harness never ran here
 *   bun run bench -- --markdown            print the README table instead of the terminal one
 *   bun run bench -- --root DIR            collect from another checkout (used by the tests)
 *
 * WHAT THIS IS, and what it is not. The three latency/memory/streaming harnesses
 * MEASURE; the six older baselines are GATES that already hold a measured number
 * with the reason written next to it. This command re-measures nothing. It
 * collects, checks that every number still carries the machine and the day it
 * came from, and prints one table plus one JSON. Re-measuring here would give
 * the same axis two numbers taken two ways, which is the failure this repo has
 * already paid for twice (a footprint read one way against a footprint read
 * another, an ink number in a gate against an ink number in a report).
 *
 * WHY THE Nth UNIT IS THE FIRST SECTION. Topics is the workspace that DRIVES
 * `claude` and `codex`, so the interesting quantity is not the total (which
 * flatters whoever ships the smaller shell) but the SLOPE: what the second
 * topic costs once the first is open, what the fourth agent costs once three
 * are running. N terminal tabs pay for everything N times; a workspace pays for
 * its shell once. That claim is a graph, and the first section is that graph.
 *
 * THREE EXITS: 0 report produced · 1 the report cannot be trusted (an artefact
 * is unreadable, a number lost its machine or its day, a row is staler than the
 * caller asked for) · 2 nothing measurable at all. The judging lives in
 * report.ts, which is pure, so every one of those rules is under test.
 *
 * HOW TO SEE IT REFUSE. `--max-age-days 0` turns yesterday's numbers into exit
 * 1; `--require-all` on a fresh clone turns the two ephemeral harnesses (their
 * artefacts land in the gitignored test-results/) into exit 1 instead of a
 * quiet "not measured". Both are in bench/README.md with their output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import {
  MACHINE_NOT_RECORDED,
  README_BEGIN,
  README_END,
  judge,
  renderMarkdown,
  renderTable,
  spliceReadme,
  type BenchReport,
  type BenchRow,
  type BenchSection,
  type RowKind,
  type SourceRef,
} from "./report";

const REPO_ROOT = resolve(join(import.meta.dir, "..", ".."));

/* ------------------------------------------------------------------ reading */

interface Loaded {
  json: unknown;
  present: boolean;
  error?: string;
}

function loadJson(root: string, rel: string): Loaded {
  const path = join(root, rel);
  if (!existsSync(path)) return { json: null, present: false };
  try {
    return { json: JSON.parse(readFileSync(path, "utf8")) as unknown, present: true };
  } catch (err) {
    return { json: null, present: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function dig(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function num(value: unknown, path: string): number | null {
  const found = dig(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function text(value: unknown, path: string, fallback: string): string {
  const found = dig(value, path);
  return typeof found === "string" && found.trim() ? found : fallback;
}

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function day(value: unknown, path: string): string {
  const iso = text(value, path, "");
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "";
}

/* --------------------------------------------------------------- row making */

interface RowOptions {
  note?: string;
  kind?: RowKind;
  /** Overrides the source-wide reason when this single number is the gap. */
  reason?: string;
}

/**
 * One factory per source, so a row can never be built with a value from one
 * artefact and the date of another. When the value is absent the row becomes a
 * declared gap: "not measured", with the reason, never a blank and never a 0.
 */
function maker(tag: string, machine: string, date: string, absentReason: string) {
  return (axis: string, value: number | null, unit: string, opts: RowOptions = {}): BenchRow => {
    const missing = value === null || !Number.isFinite(value);
    return {
      axis,
      value: missing ? null : value,
      unit,
      kind: missing ? "not-measured" : (opts.kind ?? "measured"),
      source: tag,
      machine: missing ? "-" : machine,
      date: missing ? "" : date,
      note: missing ? undefined : opts.note,
      reason: missing ? (opts.reason ?? absentReason) : undefined,
    };
  };
}

/* ------------------------------------------------------------------ sources */

const SOURCES: Array<Omit<SourceRef, "present" | "error">> = [
  {
    tag: "memory",
    file: "bench/results/memory-latest.json",
    kind: "report",
    rerun: "bun run scripts/bench/memory.ts --port 13500 --bundle <bundle> --topics 1,5,10,25 --agents 1,4",
  },
  {
    tag: "latency",
    file: "test-results/bench-latency.json",
    kind: "report",
    rerun: "E2E_PORT=13510 TOPICS_E2E_BUNDLE_DIR=<bundle> bun run scripts/bench/latency.ts",
  },
  {
    tag: "streaming",
    file: "test-results/bench-streaming.json",
    kind: "report",
    rerun: "E2E_PORT=13520 TOPICS_E2E_BUNDLE_DIR=<bundle> bun run scripts/bench/streaming.ts",
  },
  {
    tag: "turn",
    file: "bench/results/ai-latency-latest.json",
    kind: "report",
    rerun: "E2E_PORT=13540 TOPICS_E2E_BUNDLE_DIR=<bundle> bun run scripts/bench/ai-latency.ts",
  },
  { tag: "ink", file: "tests/e2e/ink-budget.json", kind: "gate", rerun: "bun run check:ink" },
  { tag: "drag", file: "scripts/drag-frames-baseline.json", kind: "gate", rerun: "bun run check:drag" },
  { tag: "scroll", file: "scripts/scroll-fluidity-baseline.json", kind: "gate", rerun: "bun run check:scroll-fluidity" },
  { tag: "route", file: "scripts/route-latency-baseline.json", kind: "gate", rerun: "bun run check:route-latency" },
  { tag: "bundle", file: "scripts/bundle-baseline.json", kind: "gate", rerun: "bun run check:bundle" },
];

/** The one axis with no artefact to read: it is asserted, never published. */
const BOARD_FEED_FILE = "tests/integration/board-payload-weight.test.ts";

/* ------------------------------------------------------------------ collect */

interface Collected {
  sections: BenchSection[];
  sources: SourceRef[];
}

export function collect(root: string): Collected {
  const loaded = new Map<string, Loaded>();
  const sources: SourceRef[] = SOURCES.map((src) => {
    const got = loadJson(root, src.file);
    loaded.set(src.tag, got);
    return { ...src, present: got.present, error: got.error };
  });
  const get = (tag: string): unknown => loaded.get(tag)?.json ?? null;
  const absent = (tag: string): string => {
    const src = sources.find((s) => s.tag === tag);
    if (src?.error) return `${src.file} could not be parsed: ${src.error}`;
    return `no artefact at ${src?.file}: that harness has not run on this machine. Re-run: ${src?.rerun}`;
  };

  const mem = get("memory");
  const lat = get("latency");
  const str = get("streaming");
  const turn = get("turn");
  const ink = get("ink");
  const drag = get("drag");
  const scroll = get("scroll");
  const route = get("route");
  const bundle = get("bundle");

  const memMachine = text(mem, "machine", MACHINE_NOT_RECORDED);
  const memDate = day(mem, "measured_at");
  const memRow = maker("memory", memMachine, memDate, absent("memory"));

  // The browser and the viewport belong to the section header, not to the
  // machine column: they are the same for every row under it, and a column
  // wide enough to hold a Chromium build number stops being readable.
  const latMachine = [
    text(lat, "machine.cpu_model", ""),
    num(lat, "machine.cpus") ? `${num(lat, "machine.cpus")} cores` : "",
    num(lat, "machine.memory_gb") ? `${num(lat, "machine.memory_gb")} GB` : "",
  ]
    .filter(Boolean)
    .join(", ") || MACHINE_NOT_RECORDED;
  const latDate = day(lat, "measured_at");
  const latRow = maker("latency", latMachine, latDate, absent("latency"));

  const strMachine = [text(str, "machine.cpu", ""), num(str, "machine.cores") ? `${num(str, "machine.cores")} cores` : ""]
    .filter(Boolean)
    .join(", ") || MACHINE_NOT_RECORDED;
  const strDate = day(str, "measured_at");
  const strRow = maker("streaming", strMachine, strDate, absent("streaming"));

  const turnMachine = text(turn, "machine", MACHINE_NOT_RECORDED);
  const turnDate = day(turn, "measured_at");
  const turnRow = maker("turn", turnMachine, turnDate, absent("turn"));

  // The four older baselines never wrote down the box they were taken on. That
  // is a real gap and it prints as one: "not recorded" is a machine nobody can
  // re-run against, and the footer counts how many rows are in that state.
  const inkRow = maker("ink", "Apple Silicon, model not recorded", text(ink, "baseline.measuredOn", ""), absent("ink"));
  const dragRow = maker("drag", MACHINE_NOT_RECORDED, text(drag, "updated", ""), absent("drag"));
  const scrollRow = maker("scroll", "macOS arm64, model not recorded", text(scroll, "updated", ""), absent("scroll"));
  const routeRow = maker("route", MACHINE_NOT_RECORDED, text(route, "updated", ""), absent("route"));
  const bundleRow = maker("bundle", MACHINE_NOT_RECORDED, text(bundle, "updated", ""), absent("bundle"));

  const curtainMs = readListRevealFloor(root);
  const boardPerCard = perCard(lat);

  const sections: BenchSection[] = [
    {
      title: "THE COST OF THE Nth UNIT",
      blurb:
        "The claim: a workspace pays for its shell once and then per unit, where N terminal tabs pay for everything N times. The slope is the architecture; the total flatters whoever ships the smaller shell.",
      rows: [
        memRow("the shell, before any topic", round(num(mem, "marginal.shell_idle_mb"), 1), "MB", {
          note: "phys_footprint summed over server + pty bridge + the renderer, at their idle prompt.",
        }),
        memRow("the FIRST topic", round(num(mem, "marginal.first_topic_mb"), 1), "MB", {
          note: "the chat machinery, paid once.",
        }),
        memRow("the Nth topic after that", round(num(mem, "marginal.per_topic_mb"), 1), "MB", {
          note: stepsNote(mem),
        }),
        memRow("the Nth agent, inside Topics", round(num(mem, "marginal.per_agent_topics_mb"), 1), "MB", {
          note: "a `claude` at its prompt plus the server-side session that owns it.",
        }),
        memRow("the same agent, bare CLI, no Topics", round(num(mem, "marginal.per_agent_bare_mb"), 1), "MB", {
          note: "the control arm: the same binary in a bare PTY, same metric, same tree walk.",
        }),
        memRow("what Topics adds per agent", round(num(mem, "marginal.agent_overhead_mb"), 1), "MB", {
          note: "the difference of the two rows above, and it sits inside the CLI's own run-to-run spread.",
        }),
        latRow("the Nth board card, painted", boardPerCard, "ms", {
          kind: "derived",
          note: "from the 50-card and 500-card board paints below: 450 more cards cost 51.6 ms on top of a fixed ~435 ms.",
        }),
        strRow("a text chunk, long thread over short", round(num(str, "cost_of_length.text_cost_long_over_short"), 2), "x", {
          note: "1.0 would mean the cost of a chunk does not know how long the conversation is. 2000 messages against 6.",
        }),
        strRow("a tool chunk, long thread over short", round(num(str, "cost_of_length.tool_cost_long_over_short"), 2), "x", {
          note: "same burst, cumulative tool output instead of text deltas.",
        }),
      ],
    },
    {
      title: "MEMORY, resident",
      metric: "MB of phys_footprint (macOS), summed over the whole process tree",
      blurb: "Never RSS: shared pages would be counted once per process. On Linux the same harness reads Pss from smaps_rollup, which is what jcode sums.",
      rows: memoryScenarioRows(mem, memRow),
    },
    {
      title: "LATENCY, gesture to ink",
      metric: "ms, median of the samples in the artefact",
      blurb:
        "The milliseconds between the gesture and the frame that PAINTED the answer, not the frame that received the data. " +
        `Shell: ${text(lat, "machine.browser", "chromium")}, ${text(lat, "machine.viewport", "headless")}.`,
      rows: [
        latRow("app boot, first frame", round(num(lat, "gestures.boot_first_frame.medianMs"), 1), "ms", {
          note: range(lat, "gestures.boot_first_frame") + " · first-contentful-paint from navigation start",
        }),
        latRow("app boot, sidebar usable", round(num(lat, "gestures.boot_interactive.medianMs"), 1), "ms", {
          note: range(lat, "gestures.boot_interactive"),
        }),
        latRow("open a topic, COLD", round(num(lat, "gestures.topic_open_cold.medianMs"), 1), "ms", {
          note: curtainNote(curtainMs, lat),
        }),
        inkRow("open a topic, WARM", round(num(ink, "baseline.tab.medianMs"), 1), "ms", {
          note: "the same click as switching between two open topics: one measurement, printed once.",
        }),
        inkRow("open a task card, drawer readable", round(num(ink, "baseline.card.medianMs"), 1), "ms", {
          note: text(ink, "baseline.card.spreadMs", ""),
        }),
        inkRow("send a message, readable in the list", round(num(ink, "baseline.send.medianMs"), 1), "ms", {
          note: text(ink, "baseline.send.spreadMs", ""),
        }),
        latRow("board painted, 50 cards", round(num(lat, "gestures.board_paint_50.medianMs"), 1), "ms", {
          note: "from navigation start, so the shell boot above is inside this number.",
        }),
        latRow("board painted, 200 cards", round(num(lat, "gestures.board_paint_200.medianMs"), 1), "ms"),
        latRow("board painted, 500 cards", round(num(lat, "gestures.board_paint_500.medianMs"), 1), "ms", {
          note: "500 cards really in the DOM: the todo column is never paged, and the spec asserts the count.",
        }),
      ],
    },
    {
      title: "STREAMING, what one chunk costs",
      metric: "us per chunk, page clock, median of 3 bursts of 1500 chunks",
      blurb: "Frames are injected into a real WebSocket route; progress is counted off the PAINTED page, not off the driver.",
      rows: [
        strRow("text delta, 6-message thread", round(num(str, "scenarios.text_short.median.cost_us_per_chunk"), 1), "us"),
        strRow("text delta, 2000-message thread", round(num(str, "scenarios.text_long.median.cost_us_per_chunk"), 1), "us"),
        strRow("tool output, 6-message thread", round(num(str, "scenarios.tool_short.median.cost_us_per_chunk"), 1), "us"),
        strRow("tool output, 2000-message thread", round(num(str, "scenarios.tool_long.median.cost_us_per_chunk"), 1), "us"),
        strRow("text chunks absorbed, long thread", round(num(str, "scenarios.text_long.median.absorbed_per_s"), 0), "chunks/s", {
          note: "a FLOOR, not a ceiling: the client was caught up milliseconds after the driver stopped handing off.",
        }),
        strRow("long tasks during a burst", num(str, "scenarios.text_long.median.longtask_count"), "count", {
          note: "0 in every scenario. A long task is 50 ms of blocked main thread.",
        }),
        strRow("layout shift outside the message list", num(str, "scenarios.text_long.median.layout_shift_outside_list"), "CLS", {
          note: "the product invariant: a streaming answer must not move the rest of the app.",
        }),
      ],
    },
    {
      title: "THE TURN, the legs this repo owns",
      metric: "ms, median",
      blurb: "Never summed: two of these overlap in wall clock, because the client is already painting its bubble while the server is still writing the row.",
      rows: [
        turnRow("Enter, to the request leaving the client", round(num(turn, "metrics.composerToWire.medianMs"), 1), "ms"),
        turnRow("request, to the turn existing", round(num(turn, "metrics.wireToAccepted.medianMs"), 1), "ms", {
          note: "in-flight gate, the SQLite write of the user row, the broadcast and one WebSocket hop back.",
        }),
        turnRow("first provider event, to first token readable", round(num(turn, "metrics.firstTokenToInk.medianMs"), 1), "ms"),
        turnRow("mid-stream event, to that token readable", round(num(turn, "metrics.midStreamTokenToInk.medianMs"), 1), "ms", {
          note: "the one that runs hundreds of times a turn.",
        }),
        turnRow("accepted, to the first provider event", null, "ms", {
          reason: text(
            turn,
            "metrics.acceptedToFirstProviderEvent.reason",
            "not measured: it belongs to the model and the network, not to this repo.",
          ),
        }),
      ],
    },
    {
      title: "FRAMES AND BYTES, from the gates that already measure them",
      blurb: "These are baselines a check compares against. This command reads them; it never re-measures them, and it never re-judges them.",
      rows: [
        dragRow("board drag, 95th percentile frame", num(drag, "measured.p95_frame_ms"), "ms", {
          note: `budget ${num(drag, "budget.p95_frame_ms") ?? "?"} ms, which is 60 FPS. Long tasks during the drag: ${num(drag, "measured.longtask_count") ?? "?"}.`,
        }),
        scrollRow("chat scroll, frames delivered late", num(scroll, "measured.dropped_pct"), "%", {
          note: `worst gap ${num(scroll, "measured.worst_gap_ms") ?? "?"} ms against a machine cadence of ${num(scroll, "measured.calibration_gap_ms") ?? "?"} ms.`,
        }),
        routeRow("GET a topic's messages", num(route, "routes.topic_messages.median_ms"), "ms", {
          note: `on a seeded corpus of ${num(route, "corpus.topics") ?? "?"} topics / ${num(route, "corpus.messages") ?? "?"} messages / ${num(route, "corpus.tasks") ?? "?"} tasks.`,
        }),
        routeRow("GET every board's tasks", num(route, "routes.all_boards_tasks.median_ms"), "ms"),
        bundleRow("entry bundle, gzipped", num(bundle, "entry_eager.gz"), "bytes", {
          note: `raw ${num(bundle, "entry_eager.raw") ?? "?"} bytes. What the browser must have before the app can paint.`,
        }),
        bundleRow("critical path, gzipped", num(bundle, "critical_path.gz"), "bytes", {
          note: `${num(bundle, "critical_path.files") ?? "?"} eager assets in index.html.`,
        }),
      ],
    },
    {
      title: "DECLARED, NOT MEASURED HERE",
      blurb: "Axes this suite names on purpose and does not have a number for. A gap that is written down can be closed; a gap nobody printed cannot.",
      rows: [
        {
          axis: "memory on Linux (Pss) and on Windows",
          value: null,
          unit: "MB",
          kind: "not-measured",
          source: "memory",
          machine: "-",
          date: "",
          reason:
            "the Linux path reads Pss from /proc/<pid>/smaps_rollup and is unit-tested, but it has never run: this box is macOS. A Pss number and a phys_footprint number are not the same measurement and are never printed in one column.",
        },
        {
          axis: "memory of the shipped Tauri shell",
          value: null,
          unit: "MB",
          kind: "not-measured",
          source: "memory",
          machine: "-",
          date: "",
          reason:
            "the memory rows are taken with Chromium (Playwright) as the renderer, because the WKWebView shell's children are XPC services reparented to pid 1 and the window cannot be driven from a script on a private port. The totals are Chromium totals; the slope is the product's.",
        },
        {
          axis: "the board feed, bytes per task",
          value: null,
          unit: "bytes",
          kind: "not-measured",
          source: "board-feed",
          machine: "-",
          date: "",
          reason: `measured, but as a GATE with no artefact: ${BOARD_FEED_FILE} asserts the invariants and a per-task ceiling on a 300-task fixture and never writes a number out. Its header records the live-database figures (467 real roots) and this suite cannot re-run those, so it does not republish them.`,
        },
        {
          axis: "other vendors' CLIs, side by side",
          value: null,
          unit: "MB",
          kind: "not-measured",
          source: "memory",
          machine: "-",
          date: "",
          reason:
            "the only control arm is `claude`, because it is the binary this machine has. A row for a CLI this repo cannot launch would be a number copied from someone else's README.",
        },
      ],
    },
  ];

  sources.push({
    tag: "board-feed",
    file: BOARD_FEED_FILE,
    kind: "gate",
    rerun: "bun test tests/integration/board-payload-weight.test.ts",
    present: existsSync(join(root, BOARD_FEED_FILE)),
  });

  return { sections, sources };
}

function memoryScenarioRows(mem: unknown, row: ReturnType<typeof maker>): BenchRow[] {
  const scenarios = dig(mem, "scenarios");
  if (!Array.isArray(scenarios)) {
    return [row("Topics idle, and every scenario under it", null, "MB")];
  }
  return scenarios.map((entry) => {
    const label = text(entry, "label", "scenario");
    const procs = num(entry, "processCount");
    return row(label, round(num(entry, "mb"), 1), "MB", {
      note: procs === null ? undefined : `${procs} process${procs === 1 ? "" : "es"} in the tree`,
    });
  });
}

function stepsNote(mem: unknown): string {
  const r2 = num(mem, "marginal.per_topic_r2");
  const steps = dig(mem, "marginal.per_topic_steps");
  const shown = Array.isArray(steps)
    ? steps.map((s) => `${num(s, "from") ?? "?"}->${num(s, "to") ?? "?"}: ${num(s, "mb") ?? "?"} MB`).join(", ")
    : "";
  const fit = r2 === null ? "" : `r2 ${r2}: `;
  return `${fit}not resolvable above this box's own jitter. Steps ${shown}. The lever that makes it resolvable: --ballast-mb 20 moved it to 20.4 MB at r2 0.999.`;
}

function range(lat: unknown, path: string): string {
  const lo = num(lat, `${path}.minMs`);
  const hi = num(lat, `${path}.maxMs`);
  return lo === null || hi === null ? "" : `range ${lo}-${hi} ms`;
}

function curtainNote(curtainMs: number | null, lat: unknown): string {
  const median = num(lat, "gestures.topic_open_cold.medianMs");
  if (curtainMs === null) {
    return "composition unknown: LIST_REVEAL_FLOOR_MS was not found in MessageList.tsx.";
  }
  const own = median === null ? null : round(median - curtainMs, 1);
  return (
    `${curtainMs} ms of it is LIST_REVEAL_FLOOR_MS, a CONSTANT in MessageList.tsx: the list is held hidden ` +
    `so nobody watches the virtualiser re-anchor. The app's own work is ${own ?? "?"} ms. Reported, never gated.`
  );
}

/** The 320 ms curtain is a decision in the source, so it is read from the source
 *  and not copied here: a number copied twice drifts on the day one of them moves. */
function readListRevealFloor(root: string): number | null {
  const path = join(root, "client/src/components/Chat/MessageList.tsx");
  if (!existsSync(path)) return null;
  const match = /LIST_REVEAL_FLOOR_MS\s*=\s*(\d+)/.exec(readFileSync(path, "utf8"));
  return match ? Number(match[1]) : null;
}

/** The marginal card: (500-card paint - 50-card paint) / 450 more cards. */
export function perCard(lat: unknown): number | null {
  const small = num(lat, "gestures.board_paint_50.medianMs");
  const large = num(lat, "gestures.board_paint_500.medianMs");
  if (small === null || large === null) return null;
  return round((large - small) / 450, 2);
}

/* ---------------------------------------------------------------------- CLI */

function hostString(): string {
  const list = cpus();
  const model = list[0]?.model ?? "unknown CPU";
  const gb = Math.round(totalmem() / 1024 ** 3);
  return `${model}, ${list.length} cores, ${gb} GB, ${process.platform} ${process.arch}`;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? (argv[at + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = option(argv, "root") ?? REPO_ROOT;
  const collected = collect(root);
  const report: BenchReport = {
    collected_at: new Date().toISOString(),
    host: hostString(),
    sections: collected.sections,
    sources: collected.sources,
  };

  const rawAge = option(argv, "max-age-days");
  if (rawAge !== null && !/^\d+$/.test(rawAge)) {
    console.error(`! --max-age-days wants a whole number of days, got "${rawAge}". Exit 2: nothing was judged.`);
    process.exit(2);
  }
  const verdict = judge(report, {
    today: new Date().toISOString().slice(0, 10),
    maxAgeDays: rawAge === null ? undefined : Number(rawAge),
    requireAll: flag(argv, "require-all"),
  });

  console.log(flag(argv, "markdown") ? renderMarkdown(report) : renderTable(report));
  console.log(
    `\n${verdict.numbered} numbers, of which ${verdict.unattributed} were taken on a machine nobody wrote down. ` +
      `${verdict.missing} axes declared and not measured.`,
  );

  if (!flag(argv, "no-write")) {
    const outDir = join(root, "bench/results");
    mkdirSync(outDir, { recursive: true });
    const stamp = `${process.platform}-${report.collected_at.slice(0, 10)}`;
    const body = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(outDir, `summary-${stamp}.json`), body);
    writeFileSync(join(outDir, "summary-latest.json"), body);
    console.log(`Written: bench/results/summary-${stamp}.json and bench/results/summary-latest.json`);
  }

  if (flag(argv, "update-readme")) {
    const readmePath = join(root, "bench/README.md");
    if (!existsSync(readmePath)) {
      console.error(`! bench/README.md is missing, so there is nothing to update.`);
      process.exit(1);
    }
    const spliced = spliceReadme(readFileSync(readmePath, "utf8"), renderMarkdown(report));
    if (spliced === null) {
      console.error(`! bench/README.md has no ${README_BEGIN} / ${README_END} block. Refusing to append a second table.`);
      process.exit(1);
    }
    writeFileSync(readmePath, spliced);
    console.log("Written: bench/README.md (the generated block only)");
  }

  if (verdict.code !== 0) {
    console.error(`\n! ${verdict.code === 2 ? "NOTHING MEASURABLE" : "THIS REPORT CANNOT BE TRUSTED"}:`);
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    if (verdict.code === 2) {
      console.error(
        `\n  Not one harness left an artefact under ${root}. Exit 2, not 1: a table of gaps is not a\n` +
          `  benchmark, and printing it green would say the opposite of what happened.`,
      );
    }
  }
  process.exit(verdict.code);
}

if (import.meta.main) {
  await main();
}
