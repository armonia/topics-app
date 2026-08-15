#!/usr/bin/env bun
/**
 * WHAT DOES THE Nth UNIT COST IN RAM.
 *
 *   bun run scripts/bench/memory.ts                       measure everything, write the JSON
 *   bun run scripts/bench/memory.ts --topics 1,5,10       fewer points, faster
 *   bun run scripts/bench/memory.ts --skip-agents         no `claude` at all
 *   bun run scripts/bench/memory.ts --ballast-mb 20       THE FALSIFICATION LEVER (see below)
 *
 * WHY IT IS NOT jcode's TABLE. jcode measures a coding CLI at 1 and at 10
 * sessions. Topics is not in that category: it is the workspace that DRIVES
 * those CLIs, so it CONTAINS the row that says "claude, 800 MB", and copying
 * the table would compare a Rust TUI against a WebView. What transfers is the
 * SHAPE — a harness anyone can re-run, one named metric, published numbers —
 * with "session" replaced by the units this product is made of: a TOPIC and a
 * DISPATCHED AGENT.
 *
 * THE CLAIM. A workspace pays for its shell ONCE and then per unit; N terminal
 * tabs pay for everything N times. So the number that matters is not the total,
 * which flatters whoever has the smaller shell, but the SLOPE. Totals are
 * printed too, because a slope with no intercept hides the entry price.
 *
 * THE METRIC, by name: `phys_footprint` on macOS, `Pss` on Linux, summed over
 * the WHOLE tree. It travels in every JSON row so two numbers taken with
 * different metrics can never be added by accident. See ./proc.ts for why `rss`
 * is not an option. The tree is the server and its children, the pty-bridge
 * with every `claude` and MCP server below it, and the Chromium that renders
 * the app with its renderers, GPU and network processes.
 *
 * WHAT IS NOT IN IT. The shell here is Chromium, not the Tauri WKWebView the
 * product ships: a Tauri window cannot be driven from a script on a private
 * port and its WKWebView children are XPC services with ppid 1. The slope is
 * still the product's slope — a topic is a React subtree inside one renderer
 * either way — but the TOTAL is a Chromium total and is labelled as such. The
 * control counts no terminal emulator, as jcode's does not: iTerm would swamp
 * the thing being compared.
 *
 * NO TOKENS ARE SPENT. Every `claude`, on both sides, is launched into a PTY
 * and left AT ITS IDLE PROMPT; no turn is ever sent. The agent rows are the
 * RESIDENT cost of having an agent open, not a mid-turn working set, and they
 * compare because both sides sit in the same state.
 *
 * THE FALSIFICATION LEVER. `--ballast-mb N` retains N MB in the page for every
 * topic opened: the per-unit leak the slope exists to catch. The measured
 * per-topic cost must rise by about N MB. A bench that cannot be shown moving
 * is decoration, and lowering a threshold would only prove that subtraction
 * works.
 *
 * EXITS: 0 measured, 1 a scenario could not be set up, 2 nothing here can be
 * measured honestly (no metric for this platform, no client bundle, no `claude`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

import {
  mb,
  measureTree,
  median,
  metricForPlatform,
  parseCounts,
  pidsMatching,
  readProcessTable,
  slopeOf,
  startBareClis,
} from "./proc";
import type { Point, ProcRow, TreeMeasure } from "./proc";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

/**
 * The prompt is READY when one of these is on screen.
 *
 * Three alternatives and not one, because which of them appears depends on
 * flags and on the CLI's own version: the shortcut hint, the placeholder in the
 * empty composer, the bypass-permissions badge. Matching on a single one is how
 * a readiness probe silently degrades into a timeout that still "measures"
 * something — a CLI caught halfway through boot, which is a different number.
 */
const CLAUDE_READY = /\? for shortcuts|bypass permissions on|Try "/;

// ---------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------

interface Options {
  port: number;
  bundleDir: string;
  outDir: string;
  topicCounts: number[];
  agentCounts: number[];
  settleMs: number;
  samples: number;
  sampleGapMs: number;
  ballastMb: number;
  headed: boolean;
  skipAgents: boolean;
  skipControl: boolean;
}

function parseArgs(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(flag("--port") ?? process.env.BENCH_PORT ?? 13500);
  return {
    port,
    bundleDir:
      flag("--bundle") ?? process.env.TOPICS_E2E_BUNDLE_DIR ?? join(REPO_ROOT, "public"),
    outDir: flag("--out") ?? join(REPO_ROOT, "bench/results"),
    topicCounts: parseCounts(flag("--topics") ?? "1,5,10,25"),
    agentCounts: parseCounts(flag("--agents") ?? "1,4"),
    settleMs: Number(flag("--settle") ?? 6000),
    samples: Number(flag("--samples") ?? 3),
    sampleGapMs: Number(flag("--sample-gap") ?? 900),
    ballastMb: Number(flag("--ballast-mb") ?? 0),
    headed: argv.includes("--headed"),
    skipAgents: argv.includes("--skip-agents"),
    skipControl: argv.includes("--skip-control"),
  };
}

/** A pause that is part of the measurement, not a workaround: freshly created
 *  panes and freshly booted CLIs are still allocating, and a number taken
 *  during that is the churn, not the resident cost. */
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Where `claude` lives, resolved the way the server resolves it. Absolute,
 *  because a bench that runs under a login shell and a server that runs under
 *  launchd must not disagree about which binary was measured. */
function resolveClaudeBin(): string | null {
  const candidates = [
    join(userInfo().homedir, ".local/bin/claude"),
    join(userInfo().homedir, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  try {
    const found = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** One scenario's published row. */
interface Scenario {
  key: string;
  label: string;
  /** The unit count this row is about (0 for idle and for the control's shell). */
  n: number;
  metric: string;
  bytes: number;
  mb: number;
  processCount: number;
  /** Every sample taken, so a reader can see how noisy the box was. */
  sampleBytes: number[];
  /** What was in the tree, named. */
  roots: Array<{ kind: string; pid: number }>;
  /** Evidence that the scenario really was set up: panes on screen, prompts reached. */
  witness: Record<string, number | string>;
}

/** One scenario's reading: the median total, every sample behind it, and the
 *  roots that were walked. */
interface Sampled {
  measure: TreeMeasure;
  sampleBytes: number[];
  roots: Array<{ kind: string; pid: number }>;
}

/**
 * Take `samples` readings of the same tree and keep the median.
 *
 * The tree is re-walked for every sample rather than reused: between two
 * readings a renderer can be spawned or reaped, and a stale pid list would
 * either miss it or sum a corpse.
 */
async function sampleTree(
  roots: Array<{ kind: string; pid: number }>,
  extraRootsFrom: ((rows: ProcRow[]) => Array<{ kind: string; pid: number }>) | null,
  opts: Options,
): Promise<Sampled | null> {
  const readings: Array<{ measure: TreeMeasure; bytes: number }> = [];
  let lastRoots = roots;
  for (let i = 0; i < Math.max(1, opts.samples); i++) {
    if (i > 0) await settle(opts.sampleGapMs);
    const rows = readProcessTable();
    lastRoots = [...roots, ...(extraRootsFrom ? extraRootsFrom(rows) : [])];
    const measure = measureTree(
      lastRoots.map((r) => r.pid),
      rows,
    );
    if (!measure) return null;
    readings.push({ measure, bytes: measure.bytes });
  }
  const bytes = median(readings.map((r) => r.bytes));
  // Keep the reading whose total IS the published median, so the pid list and
  // the byte count in the JSON describe the same instant.
  const chosen =
    readings.find((r) => r.bytes === bytes) ?? readings[Math.floor(readings.length / 2)];
  return {
    measure: { ...chosen.measure, bytes },
    sampleBytes: readings.map((r) => r.bytes),
    roots: lastRoots,
  };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  const metric = metricForPlatform(process.platform);
  if (metric === null) {
    console.error(
      `bench:memory — not measured here.\n` +
        `  ${process.platform} has no metric this harness can read honestly ` +
        `(phys_footprint on darwin, Pss on linux).\n` +
        `  Printing no number is the point: an rss total would look like an answer.`,
    );
    return 2;
  }
  if (!existsSync(join(opts.bundleDir, "index.html"))) {
    console.error(
      `bench:memory — no client bundle at ${opts.bundleDir}.\n` +
        `  Build one somewhere that is NOT public/ (that is the live production bundle):\n` +
        `    cd client && ./node_modules/.bin/vite build --outDir <dir> --emptyOutDir\n` +
        `  then pass --bundle <dir> or set TOPICS_E2E_BUNDLE_DIR.`,
    );
    return 2;
  }
  const claudeBin = opts.skipAgents && opts.skipControl ? null : resolveClaudeBin();
  if (!claudeBin && !(opts.skipAgents && opts.skipControl)) {
    console.error(
      `bench:memory — \`claude\` is not on this machine, so the agent rows cannot be measured.\n` +
        `  Re-run with --skip-agents --skip-control for the topic rows alone.`,
    );
    return 2;
  }

  // The e2e helpers derive their base URL from E2E_PORT at import time, so the
  // port has to be in the environment BEFORE they load. Reusing them is
  // deliberate: opening a topic "the way the tests do" has to mean the same
  // code, or the bench measures a pane the product would never have created.
  process.env.E2E_PORT = String(opts.port);
  const { createTopic, deleteTerminalSession } = await import(
    "../../tests/e2e/helpers/api-fixtures"
  );
  const { testServerEnv, dataDirForPort } = await import("../../tests/e2e/helpers/test-server");
  const { chromium, request } = await import("@playwright/test");

  const base = `http://127.0.0.1:${opts.port}`;
  const dataDir = dataDirForPort(opts.port);
  // CLAUDE* is scrubbed on BOTH sides. A `claude` inherits its parent's session
  // markers (CLAUDE_CODE_CHILD_SESSION and friends) and then starts in a
  // different mode than the one a user gets from a fresh terminal; scrubbing on
  // the control only would make the two sides of the comparison different
  // programs. The server side inherits from here, through the pty-bridge.
  const env: Record<string, string> = {
    ...withoutClaudeEnv(process.env),
    ...testServerEnv(opts.port),
    TOPICS_PUBLIC_DIR: opts.bundleDir,
  };
  const ptySocket = env.TOPICS_PTY_SOCKET;

  mkdirSync(opts.outDir, { recursive: true });

  // A server already on this port would be measured instead of ours, and the
  // "zero topics" row would carry somebody else's state.
  if (await probePort(opts.port)) {
    console.error(
      `bench:memory — something is already listening on :${opts.port}.\n` +
        `  This bench owns its port: stop that process or pass --port.`,
    );
    return 2;
  }

  // A bench starts from zero topics or its first row is a lie, so the data dir
  // is wiped. Which is exactly why the default e2e port is refused: on 13334
  // `dataDirForPort` returns the SHARED /tmp/topics-test-data, and this line
  // would delete the suite's baseline out from under whoever is running it.
  if (dataDir === "/tmp/topics-test-data") {
    console.error(
      `bench:memory — refusing to run on the default e2e port.\n` +
        `  Its data dir is shared with the Playwright suite and this bench wipes the one it uses.\n` +
        `  Pass --port with a port of your own.`,
    );
    return 2;
  }
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const scenarios: Scenario[] = [];
  const cleanups: Array<() => void> = [];
  const runCleanups = (): void => {
    while (cleanups.length > 0) {
      try {
        (cleanups.pop() as () => void)();
      } catch {
        /* a cleanup that throws must not hide the ones after it */
      }
    }
  };

  try {
    // --- server -----------------------------------------------------------
    console.log(`\n> starting the bench server on :${opts.port} (data ${dataDir})`);
    const server = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: REPO_ROOT,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    cleanups.push(() => server.kill("SIGTERM"));
    const up = await waitForPort(opts.port, 45000);
    if (!up) {
      console.error(`bench:memory — the server never opened :${opts.port}.`);
      return 1;
    }

    // --- shell ------------------------------------------------------------
    // A PERSISTENT context, with a profile directory we chose, because that
    // directory is how the shell is found in the process table: `launch()`
    // hides the browser pid behind a private channel, and `launchServer()` +
    // `connect()` needs a WebSocket client this runtime does not drive
    // reliably. A profile path on the command line needs neither, and it is the
    // same trick the bridge is found with, a few lines below. The profile lives
    // under the bench's data dir and not next to the results, which are
    // committed and should not carry a Chromium cache in every diff.
    const profileDir = join(dataDir, "bench-shell-profile");
    rmSync(profileDir, { recursive: true, force: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: !opts.headed,
      viewport: { width: 1440, height: 900 },
      args: ["--no-first-run"],
    });
    cleanups.push(() => void context.close());
    const page = await context.newPage();
    const api = await request.newContext();
    cleanups.push(() => void api.dispose());

    const roots = (): Array<{ kind: string; pid: number }> => [
      { kind: "server", pid: server.pid },
    ];
    // Two trees are found by a string on the command line rather than by a ppid
    // walk. The pty-bridge because it is spawned DETACHED and reparented to pid
    // 1 the moment its spawner exits (this is exactly how server/lib/fleet-
    // usage.ts finds it, and how it reaches the `claude` CLIs and MCP servers
    // under it). The shell because its browser process is not a child of this
    // script either. Both are unioned into one tree, so a helper that matches
    // both a root and a descendant is still counted once.
    const discoveredRoots = (rows: ProcRow[]): Array<{ kind: string; pid: number }> => [
      ...pidsMatching(rows, ptySocket, [process.pid]).map((pid) => ({ kind: "bridge", pid })),
      ...pidsMatching(rows, `--user-data-dir=${profileDir}`, [process.pid]).map((pid) => ({
        kind: "shell",
        pid,
      })),
    ];

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', { timeout: 30000 });
    await settle(opts.settleMs);

    const idle = await sampleTree(roots(), discoveredRoots, opts);
    if (!idle) return 2;
    scenarios.push(
      row("idle", "Topics idle (server + shell, zero topics)", 0, idle, {
        panes: await paneCount(page),
      }),
    );
    console.log(printable(scenarios[scenarios.length - 1]));

    // --- N topics ---------------------------------------------------------
    // Cumulative: topics are added up to each target and the page is reloaded,
    // because "10 topics open" means ten tabs in one shell, not ten shells.
    let created = 0;
    for (const target of opts.topicCounts) {
      // The page is parked on about:blank while the topics are seeded, and the
      // client's local snapshot is dropped with it. Pane sync is last-writer-
      // wins on a sequence number: a LIVE client keeps pushing its own snapshot,
      // whose seq outranks the seed the API just wrote, so the new topics exist
      // on the server and never reach the tab strip. Measured that way the shell
      // would look cheap for the worst possible reason. Parking the page also
      // makes every reading a cold hydrate from server state, which is the only
      // state a second device would ever see.
      await page.evaluate(() => localStorage.clear());
      await page.goto("about:blank");
      while (created < target) {
        created++;
        await createTopic(api, `bench topic ${created}`);
      }
      const seeded = await openPaneCount(api, base);
      if (seeded < target) {
        console.error(
          `bench:memory — the server holds ${seeded} open panes, not ${target}.\n` +
            `  The seed lost the pane-store race; nothing is measured rather than measuring a smaller app.`,
        );
        return 1;
      }
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="Topics sidebar"]', { timeout: 30000 });
      await waitForPanes(page, target, 60000);
      if (opts.ballastMb > 0) await addBallast(page, target, opts.ballastMb);
      await settle(opts.settleMs);
      const measured = await sampleTree(roots(), discoveredRoots, opts);
      if (!measured) return 2;
      scenarios.push(
        row(`topics-${target}`, `Topics with ${target} topic${target === 1 ? "" : "s"} open`, target, measured, {
          panes: await paneCount(page),
          ballast_mb_per_topic: opts.ballastMb,
        }),
      );
      console.log(printable(scenarios[scenarios.length - 1]));
    }

    // --- N dispatched agents ---------------------------------------------
    if (!opts.skipAgents && claudeBin) {
      const sessionIds: string[] = [];
      cleanups.push(() => {
        for (const id of sessionIds) void deleteTerminalSession(api, id);
      });
      let running = 0;
      for (const target of opts.agentCounts) {
        while (running < target) {
          running++;
          const res = await api.post(`${base}/api/terminal/sessions`, {
            data: { cwd: REPO_ROOT, type: "claude-code", name: `bench agent ${running}`, cols: 120, rows: 30 },
          });
          if (!res.ok()) {
            console.error(`bench:memory — the server refused to start agent ${running}: ${res.status()}`);
            return 1;
          }
          sessionIds.push(((await res.json()) as { id: string }).id);
        }
        const ready = await waitForAgentPrompts(api, base, sessionIds, 120000);
        if (ready < sessionIds.length) {
          console.error(
            `bench:memory — only ${ready}/${sessionIds.length} agents reached their prompt.\n` +
              `  A CLI caught mid-boot is a different number; refusing to publish it.`,
          );
          return 1;
        }
        await settle(opts.settleMs);
        const measured = await sampleTree(roots(), discoveredRoots, opts);
        if (!measured) return 2;
        scenarios.push(
          row(`agents-${target}`, `Topics with ${target} agent${target === 1 ? "" : "s"} at their prompt`, target, measured, {
            agents_ready: ready,
            topics_open: created,
          }),
        );
        console.log(printable(scenarios[scenarios.length - 1]));
      }
      for (const id of sessionIds.splice(0)) await deleteTerminalSession(api, id);
    }

    // --- the control: the same CLIs, no Topics ---------------------------
    if (!opts.skipControl && claudeBin) {
      const hostPath = join(dataDir, "bench-control-host.cjs");
      for (const target of opts.agentCounts) {
        const control = await startBareClis({
          hostPath,
          requireFrom: REPO_ROOT,
          count: target,
          bin: claudeBin,
          cwd: REPO_ROOT,
          readyPattern: CLAUDE_READY,
          timeoutMs: 120000,
        });
        if (!control) {
          console.error(`bench:memory — the control CLIs never reached their prompt.`);
          return 1;
        }
        await settle(opts.settleMs);
        // Only the CLI trees are summed. The Node host that owns the PTYs is a
        // stand-in for a terminal emulator, constant in N and present on
        // neither side of the published slope; counting it would price a
        // window the comparison is not about.
        const measured = await sampleTree(
          control.pids.map((pid) => ({ kind: "claude", pid })),
          null,
          opts,
        );
        control.stop();
        if (!measured) return 2;
        scenarios.push(
          row(`control-${target}`, `${target} bare \`claude\` at their prompt, no Topics`, target, measured, {
            host_pid: control.hostPid,
          }),
        );
        console.log(printable(scenarios[scenarios.length - 1]));
      }
    }
  } finally {
    runCleanups();
  }

  // --- the number the whole thing exists for -----------------------------
  // The idle row is deliberately NOT a point of the topic fit. Going from zero
  // topics to one pays for the chat machinery once — the transcript virtualiser,
  // the composer, the websocket wiring — and folding that one-time price into
  // the slope is what would make "the Nth topic" look expensive while making the
  // fit describe neither the first topic nor the tenth. It is published on its
  // own line instead, which is also the claim being made: shell once, then per
  // topic.
  const idleRow = scenarios.find((s) => s.key === "idle");
  const topicPoints = pointsFor(scenarios, "topics-");
  const agentPoints = pointsFor(scenarios, "agents-");
  const controlPoints = pointsFor(scenarios, "control-");
  const firstTopic = scenarios.find((s) => s.key.startsWith("topics-"));
  const topicSlope = slopeOf(topicPoints);
  const agentSlope = slopeOf(agentPoints);
  const controlSlope = slopeOf(controlPoints);

  const report = {
    measured_at: new Date().toISOString(),
    metric,
    platform: `${process.platform} ${process.arch}`,
    machine: machineName(),
    tree: {
      _: "What every Topics row sums. The bridge is found by its socket path because it is detached and reparented to pid 1.",
      server: "bun server.ts on the bench port, and its children",
      bridge: "the pty-bridge and every `claude`/MCP server under it",
      shell: "Chromium (Playwright), the pane that renders the app",
    },
    caveats: [
      "The shell is Chromium, not the Tauri WKWebView the product ships: totals are Chromium totals, the slope is the product's slope.",
      "No turn is ever sent: every CLI is measured AT ITS IDLE PROMPT, on both sides. These are resident costs, not mid-turn working sets.",
      "The control does not include a terminal emulator, the same way jcode's does not.",
      "An agent row is the CLI plus the server-side session, not an xterm pane per agent: the pane is a React subtree in the one renderer already counted, and driving the add menu N times would make the setup, not the measurement, the fragile part.",
      "The agent rows are taken with the topics of the previous rows still open, which is constant across them and therefore cancels out of the per-agent slope.",
    ],
    ballast_mb_per_topic: opts.ballastMb,
    scenarios,
    marginal: {
      _: "The slope is the architecture; the total flatters whoever has the smaller shell.",
      shell_idle_mb: idleRow ? idleRow.mb : null,
      first_topic_mb:
        idleRow && firstTopic ? mb(firstTopic.bytes - idleRow.bytes) : null,
      per_topic_mb: topicSlope ? mb(topicSlope.perUnitBytes) : null,
      per_topic_r2: topicSlope ? round(topicSlope.r2, 3) : null,
      per_topic_steps: topicSlope?.steps.map((s) => ({ ...s, mb: mb(s.perUnitBytes) })) ?? [],
      per_agent_topics_mb: agentSlope ? mb(agentSlope.perUnitBytes) : null,
      per_agent_bare_mb: controlSlope ? mb(controlSlope.perUnitBytes) : null,
      agent_overhead_mb:
        agentSlope && controlSlope
          ? mb(agentSlope.perUnitBytes - controlSlope.perUnitBytes)
          : null,
      agent_overhead_note:
        "Per-agent cost inside Topics minus the same agent bare. A value near zero, of either sign, is the finding: the Nth agent costs what the CLI costs, and the workspace around it is not paid again. A negative number is not a credit, it is that difference sitting inside the CLI's own run-to-run spread.",
    },
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = join(opts.outDir, `memory-${process.platform}-${stamp}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(opts.outDir, "memory-latest.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`THE Nth UNIT, in ${metric}, summed over the whole tree`);
  console.log(`${"=".repeat(78)}`);
  for (const s of scenarios) console.log(printable(s));
  console.log("");
  const summary: Array<[string, string]> = [];
  if (idleRow && firstTopic) {
    summary.push([
      "the shell, before any topic",
      `${idleRow.mb} MB  (+ ${mb(firstTopic.bytes - idleRow.bytes)} MB for the FIRST topic: the chat machinery, paid once)`,
    ]);
  }
  if (topicSlope) {
    summary.push([
      "marginal cost of the Nth TOPIC",
      `${mb(topicSlope.perUnitBytes)} MB  (r2 ${round(topicSlope.r2, 3)}, steps ` +
        `${topicSlope.steps.map((s) => `${s.from}->${s.to}: ${mb(s.perUnitBytes)} MB`).join(", ")})`,
    ]);
  }
  if (agentSlope) summary.push(["marginal cost of the Nth AGENT", `${mb(agentSlope.perUnitBytes)} MB  inside Topics`]);
  if (controlSlope) summary.push(["the same agent, bare CLI", `${mb(controlSlope.perUnitBytes)} MB  no Topics`]);
  if (agentSlope && controlSlope) {
    summary.push([
      "what Topics adds per agent",
      `${mb(agentSlope.perUnitBytes - controlSlope.perUnitBytes)} MB`,
    ]);
  }
  for (const [label, value] of summary) console.log(`  ${label.padEnd(33)}${value}`);
  // An r2 this low does not mean the fit is broken, it means the per-unit cost
  // is at or under the jitter of the box between two scenarios taken minutes
  // apart. Saying so is the honest reading; quoting the slope alone would give
  // three decimal places to a number the machine cannot resolve.
  if (topicSlope && topicSlope.r2 < 0.8) {
    console.log(
      `\n  NOTE: the topic points are not on a line (r2 ${round(topicSlope.r2, 3)}).\n` +
        `  Read that as "the Nth topic costs at most ${mb(Math.abs(topicSlope.perUnitBytes))} MB, and less than this\n` +
        `  machine can resolve between two readings", not as a precise slope.`,
    );
  }
  console.log(`\n  written to ${outPath}`);
  return 0;
}

// --- small helpers ---------------------------------------------------------

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** The box a number came from. A memory figure without it is not reproducible. */
function machineName(): string {
  try {
    const out = execFileSync("sysctl", ["-n", "hw.model", "hw.ncpu", "hw.memsize"], { encoding: "utf8" });
    const [model, cores, ram] = out.trim().split("\n");
    return `${model}, ${cores} cores, ${Math.round(Number(ram) / 1024 ** 3)} GB`;
  } catch {
    return "unknown";
  }
}

function row(
  key: string,
  label: string,
  n: number,
  measured: Sampled,
  witness: Record<string, number | string>,
): Scenario {
  return {
    key,
    label,
    n,
    metric: measured.measure.metric,
    bytes: measured.measure.bytes,
    mb: mb(measured.measure.bytes),
    processCount: measured.measure.processCount,
    sampleBytes: measured.sampleBytes,
    roots: measured.roots,
    witness,
  };
}

function printable(s: Scenario): string {
  const witness = Object.entries(s.witness)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `  ${s.label.padEnd(52)} ${String(s.mb).padStart(8)} MB  ${String(s.processCount).padStart(3)} proc  ${witness}`;
}

/** The measured points of one scenario family, as the slope wants them. */
function pointsFor(scenarios: Scenario[], prefix: string): Point[] {
  return scenarios.filter((s) => s.key.startsWith(prefix)).map((s) => ({ n: s.n, bytes: s.bytes }));
}

async function probePort(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((res) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => (socket.destroy(), res(true)));
    socket.on("error", () => res(false));
    socket.setTimeout(1000, () => (socket.destroy(), res(false)));
  });
}

/** `timeoutMs` 0 = one probe, which is how the "port already taken" check asks. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probePort(port)) return true;
    await settle(400);
  } while (Date.now() < deadline);
  return false;
}

/** Drop every CLAUDE* variable. See the call site for why both sides need it. */
export function withoutClaudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("CLAUDE")) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function paneCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("[data-pane-id]").length);
}

/** The bench claims "N topics open"; this is what makes that claim checkable.
 *  A number measured against a page that rendered three of the twenty-five
 *  would be a smaller number for the wrong reason. */
async function waitForPanes(page: Page, n: number, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (want: number) => document.querySelectorAll("[data-pane-id]").length >= want,
    n,
    { timeout: timeoutMs },
  );
}

/** Retain `mb` megabytes per topic inside the page: the injected per-unit leak
 *  that must make the measured slope rise by the same amount. */
async function addBallast(page: Page, topics: number, megabytes: number): Promise<void> {
  await page.evaluate(
    (arg: { topics: number; megabytes: number }) => {
      const w = window as unknown as { __benchBallast?: Uint8Array[] };
      if (!w.__benchBallast) w.__benchBallast = [];
      while (w.__benchBallast.length < arg.topics) {
        const block = new Uint8Array(arg.megabytes * 1024 * 1024);
        // Touched, not just allocated: an untouched allocation is address space,
        // not resident pages, and would not move a footprint at all.
        block.fill(1);
        w.__benchBallast.push(block);
      }
    },
    { topics, megabytes },
  );
}

/** How many panes the SERVER thinks are open. Checked before the page is
 *  loaded so a lost seed is reported as a lost seed, not as a timeout waiting
 *  for tabs that were never going to exist. */
async function openPaneCount(api: APIRequestContext, base: string): Promise<number> {
  try {
    const res = await api.get(`${base}/api/ui-state/pane-store-v2`);
    if (!res.ok()) return 0;
    const body = (await res.json()) as {
      value?: { groups?: Record<string, { paneIds?: string[] }> };
    };
    const groups = body.value?.groups ?? {};
    return Object.values(groups).reduce((sum, g) => sum + (g.paneIds?.length ?? 0), 0);
  } catch {
    return 0;
  }
}

/** Poll each agent's scrollback until its prompt is up. Reads the buffer route,
 *  which is token-gated; the bench server runs with the e2e token. */
async function waitForAgentPrompts(
  api: APIRequestContext,
  base: string,
  sessionIds: string[],
  timeoutMs: number,
): Promise<number> {
  const ready = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && ready.size < sessionIds.length) {
    for (const id of sessionIds) {
      if (ready.has(id)) continue;
      try {
        const res = await api.get(`${base}/api/terminal/sessions/${id}/buffer`, {
          headers: { "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token" },
        });
        if (!res.ok()) continue;
        const body = (await res.json()) as { buffer?: string };
        if (body.buffer && CLAUDE_READY.test(body.buffer)) ready.add(id);
      } catch {
        /* the session may not have a buffer yet */
      }
    }
    if (ready.size < sessionIds.length) await settle(1000);
  }
  return ready.size;
}

if (import.meta.main) {
  process.exit(await main());
}
