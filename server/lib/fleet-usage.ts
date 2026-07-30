/**
 * Fleet usage — how much machine the SERVER SIDE of Topics is really using.
 *
 * WHY THIS EXISTS: `/api/system/status` used to report `process.memoryUsage().rss`,
 * i.e. the Bun process and nothing else. Measured on a live box that reads ~87 MB
 * while the work the server actually owns — the detached pty-bridge and the whole
 * tree of `claude` CLIs, MCP servers and headless Chromes hanging off it, plus the
 * ai-bridge and the WebRTC sidecar — was ~5 GB across ~95 processes. The one number
 * the status bar exists to show was off by roughly 50x.
 *
 * The desktop shell has the same problem SOLVED on its side (`perf_metrics` in
 * desktop-tauri walks the macOS "responsible process" set and sums footprint), but
 * that set covers the shell and its WKWebView XPC services only: the sidecars are
 * launchd-reparented children of the SERVER and never appear in it. This module is
 * the server's half of the same answer.
 *
 * HOW: the sidecars are spawned detached (they survive a server restart and are
 * reparented to pid 1), so walking ppid from our own pid finds nothing. What is
 * stable is their COMMAND LINE: every sidecar is launched with `--socket <path>`
 * where the path is derived from the data instance, so it is unique per server
 * (prod vs test vs a second dev instance) and cannot collide. Each sidecar module
 * registers its socket path here at import time; one `ps` snapshot then resolves
 * pid + descendants for each root.
 *
 * METRIC HONESTY: this sums `ps rss`, not the phys_footprint the shell reports.
 * RSS over-counts pages shared between processes and under-counts what the OS has
 * compressed or swapped out. It is the portable number (`ps` exists everywhere the
 * server runs) and the right order of magnitude; it is NOT the same metric as the
 * shell's, so the client labels the two separately instead of pretending one sum.
 */

const isWindows = process.platform === "win32";

/** Sidecars that hold the server-side fleet. Kept as a closed union so a typo
 *  in a registration site is a type error, not a silently missing 4 GB. */
export type FleetKind = "pty-bridge" | "ai-bridge" | "webrtc-bridge";

const sockets = new Map<FleetKind, string>();

/**
 * Declare "the process whose command line contains this socket path is one of
 * ours". Called at module scope by each sidecar client. Idempotent; the last
 * registration wins (a socket path is recomputed only when the data dir changes,
 * which in practice means a different process entirely).
 */
export function registerFleetSocket(kind: FleetKind, socketPath: string): void {
  if (socketPath) sockets.set(kind, socketPath);
}

/** Test seam: forget every registration (unit tests register their own). */
export function _resetFleetSockets(): void {
  sockets.clear();
}

export interface FleetRootUsage {
  kind: FleetKind | "server";
  pid: number;
  processCount: number;
  memoryMB: number;
  cpuPercent: number;
}

export interface FleetUsage {
  /** Processes counted, including the server itself. */
  processCount: number;
  /** Sum of `ps rss` over the whole fleet, in MB. */
  memoryMB: number;
  /** Sum of `ps %cpu`; > 100 is normal and correct on a multi-core box. */
  cpuPercent: number;
  /** Per-root split, so the dropdown can say WHERE the memory is. */
  roots: FleetRootUsage[];
  /** False when the platform has no usable `ps` (Windows) — the client then
   *  keeps showing the single-process figure instead of a confident wrong one. */
  supported: boolean;
}

export interface PsRow {
  pid: number;
  ppid: number;
  rssKB: number;
  cpu: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,rss=,pcpu=,command=`. Exported for the unit test:
 *  the parsing (not the spawning) is where this can silently go wrong. */
export function parsePsRows(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: +m[1], ppid: +m[2], rssKB: +m[3], cpu: parseFloat(m[4]), command: m[5] });
  }
  return rows;
}

/**
 * Sum rss/cpu over `roots` and every descendant of theirs, counting each pid once
 * (a pid reachable from two roots must not be billed twice). Pure — the test
 * drives it with a synthetic table instead of the live machine.
 */
export function summarizeFleet(
  rows: PsRow[],
  roots: { kind: FleetKind | "server"; pid: number }[],
): Omit<FleetUsage, "supported"> {
  const byPid = new Map<number, PsRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const arr = children.get(r.ppid);
    if (arr) arr.push(r.pid); else children.set(r.ppid, [r.pid]);
  }

  const counted = new Set<number>();
  const rootUsages: FleetRootUsage[] = [];

  for (const root of roots) {
    if (!byPid.has(root.pid)) continue;
    let procs = 0, rssKB = 0, cpu = 0;
    const stack = [root.pid];
    const seenHere = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seenHere.has(pid)) continue;
      seenHere.add(pid);
      for (const c of children.get(pid) ?? []) stack.push(c);
      if (counted.has(pid)) continue; // already billed to an earlier root
      counted.add(pid);
      const row = byPid.get(pid);
      if (!row) continue;
      procs++;
      rssKB += row.rssKB;
      cpu += row.cpu;
    }
    rootUsages.push({
      kind: root.kind,
      pid: root.pid,
      processCount: procs,
      memoryMB: Math.round(rssKB / 1024),
      cpuPercent: Math.round(cpu * 10) / 10,
    });
  }

  return {
    processCount: rootUsages.reduce((a, r) => a + r.processCount, 0),
    memoryMB: rootUsages.reduce((a, r) => a + r.memoryMB, 0),
    cpuPercent: Math.round(rootUsages.reduce((a, r) => a + r.cpuPercent, 0) * 10) / 10,
    roots: rootUsages,
  };
}

/** Resolve the registered sockets to live pids using one `ps` snapshot. */
export function resolveFleetRoots(rows: PsRow[], selfPid: number): { kind: FleetKind | "server"; pid: number }[] {
  const roots: { kind: FleetKind | "server"; pid: number }[] = [{ kind: "server", pid: selfPid }];
  for (const [kind, sock] of sockets) {
    // The sidecar's own command line contains `--socket <path>`. Skip ourselves:
    // the server never carries the socket on its argv, but a future refactor
    // might, and billing the server twice would be silent double counting.
    const hit = rows.find(r => r.pid !== selfPid && r.command.includes(sock));
    if (hit) roots.push({ kind, pid: hit.pid });
  }
  return roots;
}

// One snapshot shared by every caller in a window. The status endpoint is polled
// at 5s by the status bar and faster by the dropdown; `ps -axo … command=` over
// ~500 processes is cheap but not free, so it is not run per request.
let cached: FleetUsage | null = null;
let cachedAt = 0;
const FLEET_TTL_MS = 4000;

export async function getFleetUsage(): Promise<FleetUsage> {
  const unsupported: FleetUsage = { processCount: 0, memoryMB: 0, cpuPercent: 0, roots: [], supported: false };
  if (isWindows) return unsupported;
  const now = Date.now();
  if (cached && now - cachedAt < FLEET_TTL_MS) return cached;
  try {
    const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,pcpu=,command="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const rows = parsePsRows(text);
    if (!rows.length) return cached ?? unsupported;
    const usage = { ...summarizeFleet(rows, resolveFleetRoots(rows, process.pid)), supported: true };
    cached = usage;
    cachedAt = now;
    return usage;
  } catch {
    // Keep the last good reading rather than flashing a zero through the UI.
    return cached ?? unsupported;
  }
}
