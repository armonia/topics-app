#!/usr/bin/env bun
/**
 * THE RENDERER GROWTH BAR, ON THE REAL APP: does the window's footprint climb?
 *
 * WHY IT EXISTS. On 2026-11-27 the app's `com.apple.WebKit.WebContent` held
 * 2337 MB after 9h34m of normal use - the biggest process on the machine, with
 * swap full and the dispatcher holding cards back for lack of memory. The repo
 * already had the measurement (`scripts/mem-growth.ts`) but not a VERDICT: it
 * printed a curve and always exited 0, so nothing could ever go red. This is
 * the same curve with a declared limit and an exit code, narrowed to the one
 * process that card is about.
 *
 * WHAT IT MEASURES. `phys_footprint` of the heaviest WebContent macOS holds
 * the app responsible for, sampled over several minutes, and the slope over
 * the second half of the series (the first half is startup, which allocates
 * for a living). Not `ps rss`: with swap in use the resident size describes
 * the hole rather than the process.
 *
 * HOW TO READ A RED. A slope past the limit says the renderer accumulates
 * without pruning; it does NOT say who. That next question belongs to
 * `devHeapProbe` in the client, which counts live entities, and to
 * `tests/e2e/renderer-heap-growth.spec.ts`, which weighs one churn lap against
 * the next in bytes.
 *
 * Leave the window ALONE while this runs: scrolling a chat or loading a page
 * allocates, and a sample taken mid-decode is not the question being asked.
 *
 * Usage:
 *   bun run check:renderer-growth                       # 20 min, 0.5 MB/min
 *   bun run check:renderer-growth -- --minutes 40 --every 20 --max 1
 *   bun run check:renderer-growth -- --json out.json
 *
 * Exit: 0 flat, 1 growing past the limit, 2 nothing to measure (app not
 * running, or not macOS).
 */
import { spawnSync } from "child_process";
import {
  judgeGrowth,
  pickRenderer,
  type FootprintPoint,
  type ProcessRow,
} from "./footprint-growth";

/**
 * At this slope a ten-hour day adds 300 MB to the renderer, which is the most
 * a desktop window should ever cost. The leak that opened the card ran at
 * roughly 4 MB/min, eight times this.
 */
const DEFAULT_MAX_MB_PER_MIN = 0.5;
const DEFAULT_MINUTES = 20;
const DEFAULT_EVERY_S = 30;

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MINUTES = flag("minutes", DEFAULT_MINUTES);
const EVERY_S = flag("every", DEFAULT_EVERY_S);
const MAX_MB_PER_MIN = flag("max", DEFAULT_MAX_MB_PER_MIN);
const jsonIdx = process.argv.indexOf("--json");
const JSON_PATH = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null;

if (process.platform !== "darwin") {
  console.log("`phys_footprint` is a macOS metric: nothing to measure here, and nothing claimed.");
  process.exit(2);
}

/** One reading of `mem-report --json`, which already knows how to find the webviews. */
function readRows(): ProcessRow[] {
  const r = spawnSync("bun", ["run", "scripts/mem-report.ts", "--json"], {
    encoding: "utf-8",
    cwd: import.meta.dir + "/..",
  });
  try {
    const j = JSON.parse(r.stdout) as { device?: { rows?: ProcessRow[] } };
    return j.device?.rows ?? [];
  } catch {
    return [];
  }
}

const series: FootprintPoint[] = [];
const t0 = Date.now();
const end = t0 + MINUTES * 60_000;
let pid: number | null = null;

console.log(
  `renderer footprint for ${MINUTES} min, one sample every ${EVERY_S}s, ` +
    `limit ${MAX_MB_PER_MIN} MB/min - leave the window alone`,
);
console.log(`${"min".padStart(6)}  ${"pid".padStart(7)}  ${"footprint MB".padStart(13)}`);

while (Date.now() < end) {
  const renderer = pickRenderer(readRows());
  if (renderer) {
    // A renderer that changes pid mid-run is a reload or a crash, not growth:
    // the series restarts, because comparing two processes measures neither.
    if (pid !== null && renderer.pid !== pid) {
      console.log(`  renderer pid changed ${pid} -> ${renderer.pid}: series restarts`);
      series.length = 0;
    }
    pid = renderer.pid;
    series.push({ t: Date.now() - t0, mb: renderer.footprintMB });
    const min = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(
      `${min.padStart(6)}  ${String(renderer.pid).padStart(7)}  ` +
        `${renderer.footprintMB.toFixed(0).padStart(13)}`,
    );
  }
  await Bun.sleep(EVERY_S * 1000);
}

if (pid === null) {
  console.log("no WebContent of the app found: is the desktop app running?");
  process.exit(2);
}

const verdict = judgeGrowth(series, MAX_MB_PER_MIN);
console.log(`\n${verdict.reason}`);
if (JSON_PATH) {
  await Bun.write(JSON_PATH, JSON.stringify({ pid, minutes: MINUTES, series, verdict }, null, 2));
  console.log(`series written to ${JSON_PATH}`);
}
process.exit(verdict.ok ? 0 : 1);
