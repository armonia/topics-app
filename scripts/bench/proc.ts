/**
 * THE PLATFORM MEMORY PRIMITIVE for the bench, and everything else in it that a
 * unit test can drive without booting a server: the tree walk, the arithmetic
 * over a set of measurements (bottom of the file), and the bare-CLI control arm
 * (bottom of the file). The harness in ./memory.ts holds only the scenarios.
 *
 * The main job here: given a set of root pids, answer "how many bytes of real
 * memory does this whole process tree hold", with the metric NAMED so two
 * numbers are never compared across metrics.
 *
 * WHY NOT `ps rss`. On macOS `rss` counts every SHARED page once per process,
 * and the thing we measure is a tree of processes sharing one Bun runtime and
 * one Chromium framework: measured on this repo's own fleet (server/lib/fleet-
 * usage.ts, 2026-08-04) the same 19-process tree read 2.07 GB of `rss` against
 * 1.17 GB of footprint, 44% apart. It diverges the OTHER way too: `rss` misses
 * what the kernel compressed or swapped, which `phys_footprint` includes, and
 * summing every process on that box gave a footprint 3x the `rss`. A bench that
 * mixed the two would publish a number that means nothing.
 *
 * SO:
 *   macOS   `phys_footprint` from `proc_pid_rusage` (rusage_info_v2). Same
 *           number Activity Monitor's "Memory" column shows, same number the
 *           Tauri shell's `perf_metrics` and the server's fleet gauge use, and
 *           the same family as `footprint -p <pid>`'s `phys_footprint:` line.
 *           Read over FFI and not by shelling out: `footprint -p` costs ~40 ms
 *           a pid, and a Topics tree with four agents is well over a hundred
 *           pids, so the walk would take longer than the thing it measures.
 *   Linux   `Pss` from `/proc/<pid>/smaps_rollup`, which is what jcode's
 *           `bench_memory_cli.py` sums. PSS is the honest analogue: it splits
 *           each shared page across the processes mapping it.
 *   else    NOT MEASURED. The caller prints that instead of a number.
 *
 * THE TREE, not the process. Every root here hides most of its cost in
 * children: Chromium puts each renderer, the GPU process and the network
 * service in their own pids; the Topics server pushes the pty-bridge, the
 * `claude` CLIs, their MCP servers and their headless Chromes under it. The
 * server's own `process.memoryUsage().rss` read 87 MB while the fleet it owned
 * held ~5 GB, a 50x miss. Sum the tree or do not publish the number.
 *
 * THE TREE IS NOT ALWAYS A ppid WALK. The pty-bridge is spawned DETACHED and
 * reparented to pid 1, so no ppid walk from the server reaches it or the agents
 * under it. It is found the way the server itself finds it — by the `--socket
 * <path>` on its command line, which is unique per data instance. That is what
 * `pidsMatching` is for.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** The metric a platform can answer honestly. `null` means "do not print a number". */
export type MemMetric = "phys_footprint" | "pss";

/** One row of the process table, reduced to what a tree walk needs. */
export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

/** What a tree measurement says about itself, so a reader can check the claim. */
export interface TreeMeasure {
  metric: MemMetric;
  platform: string;
  /** Every pid that was summed, roots included. */
  pids: number[];
  processCount: number;
  bytes: number;
  /** Pids in the tree the kernel would not answer for (died mid-walk, mostly). */
  unreadable: number[];
  /** Per-pid bytes, for the "where did it go" column of a report. */
  byPid: Record<number, number>;
}

/**
 * Which metric this platform can answer, by name.
 *
 * Pure and separate from the reading so the choice itself is testable: the
 * failure this guards against is a bench that silently falls back to `rss` on a
 * platform it cannot measure and publishes the number anyway.
 */
export function metricForPlatform(platform: string): MemMetric | null {
  if (platform === "darwin") return "phys_footprint";
  if (platform === "linux") return "pss";
  return null;
}

/**
 * Parse `ps -axo pid=,ppid=,command=`.
 *
 * The command is everything after the two numbers and keeps its spaces: it is
 * what `pidsMatching` searches, and a socket path with a space in it would
 * otherwise be cut in half.
 */
export function parsePsRows(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/**
 * Every pid reachable from `roots` through ppid, roots included.
 *
 * Cycle-safe by construction (a pid enters `seen` before its children are
 * queued): on macOS a reparented process can report a ppid that, in a snapshot
 * taken while pids are being recycled, points back into the set. A walk that
 * trusted the table to be a forest would hang there.
 *
 * Roots that are not in the table are dropped, not invented: a dead root
 * contributes no pid rather than a phantom one.
 */
export function treeOf(rows: ProcRow[], roots: number[]): number[] {
  const children = new Map<number, number[]>();
  const known = new Set<number>();
  for (const row of rows) {
    known.add(row.pid);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const seen = new Set<number>();
  const queue = roots.filter((pid) => known.has(pid));
  for (const pid of queue) seen.add(pid);
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Pids whose command line contains `needle`, minus the excluded ones.
 *
 * `exclude` exists because the searcher is itself a process: a bench that greps
 * for its own socket path finds the `ps` it just spawned, or its own argv, and
 * counts a few megabytes of itself into the product's total.
 */
export function pidsMatching(rows: ProcRow[], needle: string, exclude: number[] = []): number[] {
  const skip = new Set(exclude);
  return rows
    .filter((row) => !skip.has(row.pid) && row.command.includes(needle))
    .map((row) => row.pid);
}

/** `Pss:` from a Linux `/proc/<pid>/smaps_rollup`, in KB. `null` when absent. */
export function parseSmapsRollup(text: string): number | null {
  const m = text.match(/^Pss:\s+(\d+)\s+kB$/m);
  return m ? Number(m[1]) : null;
}

/**
 * `phys_footprint` for one pid, in bytes, over `proc_pid_rusage`.
 *
 * Built once and captured: `dlopen` per call would dominate a hundred-pid walk.
 * Any failure to open libSystem degrades to "cannot read", never to a different
 * metric, because a silent fallback to `rss` is the exact defect this file
 * exists to prevent.
 */
const machFootprintBytes: (pid: number) => number | null = (() => {
  if (process.platform !== "darwin") return () => null;
  try {
    // rusage_info_v2 layout: 16 bytes of uuid, then uint64 fields;
    // `ri_phys_footprint` is the seventh of them, at 16 + 7*8 = 72.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const buf = new BigUint64Array(64);
    const view = new DataView(buf.buffer);
    return (pid: number): number | null => {
      try {
        // RUSAGE_INFO_V2 = 2; non-zero return means the pid is gone or not ours.
        if (lib.symbols.proc_pid_rusage(pid, 2, buf) !== 0) return null;
        const bytes = view.getBigUint64(72, true);
        return bytes > 0n ? Number(bytes) : null;
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
})();

/** Bytes held by one pid under this platform's metric, or `null` if unreadable. */
export function memoryBytesOf(pid: number): number | null {
  const metric = metricForPlatform(process.platform);
  if (metric === "phys_footprint") return machFootprintBytes(pid);
  if (metric === "pss") {
    try {
      const kb = parseSmapsRollup(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      return kb === null ? null : kb * 1024;
    } catch {
      return null;
    }
  }
  return null;
}

/** One snapshot of the process table. Taken once per measurement, then reused. */
export function readProcessTable(): ProcRow[] {
  try {
    return parsePsRows(execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }));
  } catch {
    return [];
  }
}

/**
 * Sum a whole tree under this platform's metric.
 *
 * `null` when the platform has no honest metric: the caller must print
 * "not measured here" rather than a number taken with something else.
 */
export function measureTree(roots: number[], rows?: ProcRow[]): TreeMeasure | null {
  const metric = metricForPlatform(process.platform);
  if (metric === null) return null;
  const table = rows ?? readProcessTable();
  const pids = treeOf(table, roots);
  const byPid: Record<number, number> = {};
  const unreadable: number[] = [];
  let bytes = 0;
  for (const pid of pids) {
    const value = memoryBytesOf(pid);
    if (value === null) {
      unreadable.push(pid);
      continue;
    }
    byPid[pid] = value;
    bytes += value;
  }
  return {
    metric,
    platform: process.platform,
    pids,
    processCount: pids.length,
    bytes,
    unreadable,
    byPid,
  };
}

/** Bytes as MB with one decimal — the unit every row of the report is printed in. */
export function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// THE ARITHMETIC OVER THE NUMBERS THE PRIMITIVE ABOVE PRODUCES.
//
// It lives next to the reading and not in the harness for one reason: this is
// the half a unit test can drive. The harness needs a server, a browser and
// four `claude` CLIs before it produces a single number, so nothing in it can
// be checked cheaply; the slope, the median and the argument parsing are pure
// functions over a list, and they are exactly where a bench goes wrong without
// ever failing. See scripts/bench/memory.test.ts.
// ---------------------------------------------------------------------------

/** One measured point of a scenario family: N units, and the bytes it took. */
export interface Point {
  n: number;
  bytes: number;
}

/** The marginal cost of one more unit, and how well a line describes the points. */
export interface Slope {
  /** Least-squares slope: bytes per additional unit. */
  perUnitBytes: number;
  /** Least-squares intercept: what the shell costs before the first unit. */
  interceptBytes: number;
  /**
   * Coefficient of determination. Published because a slope quoted from points
   * that are not on a line is a summary of nothing: a residency cap, a GC that
   * fires between two points, a page that stopped rendering panes all bend the
   * curve, and r2 is the reader's warning that they did.
   */
  r2: number;
  /** Consecutive deltas, in order: the raw evidence behind the fitted line. */
  steps: Array<{ from: number; to: number; perUnitBytes: number }>;
}

/**
 * Fit bytes = intercept + perUnit * n over the measured points.
 *
 * `null` for fewer than two DISTINCT values of n: one point has no slope, and
 * two points at the same n have an undefined one. Returning null rather than 0
 * keeps "not enough evidence" from being printed as "costs nothing".
 */
export function slopeOf(points: Point[]): Slope | null {
  const sorted = [...points].sort((a, b) => a.n - b.n);
  const distinct = new Set(sorted.map((p) => p.n));
  if (sorted.length < 2 || distinct.size < 2) return null;

  const count = sorted.length;
  const meanN = sorted.reduce((sum, p) => sum + p.n, 0) / count;
  const meanBytes = sorted.reduce((sum, p) => sum + p.bytes, 0) / count;
  let covariance = 0;
  let variance = 0;
  for (const p of sorted) {
    covariance += (p.n - meanN) * (p.bytes - meanBytes);
    variance += (p.n - meanN) ** 2;
  }
  const perUnitBytes = covariance / variance;
  const interceptBytes = meanBytes - perUnitBytes * meanN;

  let residual = 0;
  let total = 0;
  for (const p of sorted) {
    residual += (p.bytes - (interceptBytes + perUnitBytes * p.n)) ** 2;
    total += (p.bytes - meanBytes) ** 2;
  }
  // A perfectly flat set of points has zero total variance: the line explains
  // all of nothing, which is r2 = 1, not a division by zero.
  const r2 = total === 0 ? 1 : 1 - residual / total;

  const steps = sorted.slice(1).map((p, i) => ({
    from: sorted[i].n,
    to: p.n,
    perUnitBytes: (p.bytes - sorted[i].bytes) / (p.n - sorted[i].n),
  }));

  return { perUnitBytes, interceptBytes, r2, steps };
}

/** The median of a sample set. Used over the mean: one page fault storm during
 *  a sample should not move the published number. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Parse `--topics 1,5,10,25` into positive integers, in order, deduplicated. */
export function parseCounts(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n <= 0) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// THE CONTROL ARM: N bare CLIs in real PTYs, and nothing else.
//
// It lives here and not in the harness because it is the one part of the bench
// that knows nothing about Topics: it is the "what would this cost without us"
// side of the comparison, and it is pure process handling.
// ---------------------------------------------------------------------------

/** What the control needs to be spawned and to prove it came up. */
export interface BareCliSpec {
  /** Where the generated Node host is written (scratch, never the results dir). */
  hostPath: string;
  /** A directory whose package.json can `require('node-pty')`. */
  requireFrom: string;
  count: number;
  bin: string;
  cwd: string;
  /** What "the prompt is up" looks like on screen. */
  readyPattern: RegExp;
  timeoutMs: number;
}

export interface BareClis {
  hostPid: number;
  /** The CLI pids. The host itself is deliberately NOT one of them. */
  pids: number[];
  stop: () => void;
}

/**
 * The generated CJS host.
 *
 * It exists as a written file rather than a checked-in script because
 * `node-pty` is a native addon that does not load under Bun (the pty-bridge
 * carries the same note), so the control has to be spawned from a Node host.
 * Writing it next to the bench's scratch keeps the run reproducible: the reader
 * can open the exact file the control was.
 */
function bareCliHostSource(readyPattern: RegExp): string {
  return `// Generated by scripts/bench/proc.ts — the bare-CLI control.
// Spawns N CLIs in real PTYs, reports each pid and each readiness on stdout as
// JSON lines, then idles until killed. It NEVER writes to a PTY, so no turn is
// ever sent and no tokens are spent: the CLIs sit at their prompt.
const { createRequire } = require('node:module');
const req = createRequire(process.argv[2] + '/package.json');
const pty = req('node-pty');
const count = Number(process.argv[3]);
const bin = process.argv[4];
const cwd = process.argv[5];
const READY = ${readyPattern.toString()};
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  // A CLI inherits its parent's session markers and would start in a different
  // mode than the one a user gets from a fresh terminal. Both sides of this
  // bench must launch from the same clean slate.
  if (k.startsWith('CLAUDE')) continue;
  if (typeof v === 'string') env[k] = v;
}
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const kids = [];
for (let i = 0; i < count; i++) {
  const p = pty.spawn(bin, ['--dangerously-skip-permissions'], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd, env,
  });
  kids.push(p);
  let buf = '';
  let ready = false;
  p.onData((d) => {
    if (ready) return;
    buf += d;
    if (buf.length > 200000) buf = buf.slice(-100000);
    if (READY.test(buf)) { ready = true; say({ event: 'ready', index: i, pid: p.pid }); }
  });
  say({ event: 'spawned', index: i, pid: p.pid });
}
const bye = () => { for (const k of kids) { try { k.kill(); } catch {} } process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
setInterval(() => {}, 1 << 30);
`;
}

/**
 * Start the control and wait until every CLI under it is at its prompt.
 *
 * `null` when they are not all up in time. A CLI caught halfway through boot
 * holds a different amount of memory than one at its prompt, so half a control
 * is not a smaller control: it is a different measurement wearing the same
 * label.
 */
export async function startBareClis(spec: BareCliSpec): Promise<BareClis | null> {
  writeFileSync(spec.hostPath, bareCliHostSource(spec.readyPattern));
  const host = Bun.spawn(
    ["node", spec.hostPath, spec.requireFrom, String(spec.count), spec.bin, spec.cwd],
    { stdout: "pipe", stderr: "ignore", env: process.env },
  );
  const stop = (): void => host.kill("SIGTERM");
  const pids = new Set<number>();
  const ready = new Set<number>();

  // The events are drained in the background and the WAIT is a deadline poll,
  // not a race against a blocking read: a CLI that never reaches its prompt
  // would leave a `read()` pending forever, and the bench would hang instead of
  // saying that the control did not come up.
  const drain = (async (): Promise<void> => {
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { event: string; pid: number };
          if (event.event === "spawned") pids.add(event.pid);
          if (event.event === "ready") ready.add(event.pid);
        } catch {
          /* the host only ever writes JSON lines; anything else is noise */
        }
      }
    }
  })();
  void drain.catch(() => undefined);

  const deadline = Date.now() + spec.timeoutMs;
  while (Date.now() < deadline && ready.size < spec.count) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ready.size < spec.count) {
    stop();
    return null;
  }
  return { hostPid: host.pid, pids: [...pids], stop };
}
