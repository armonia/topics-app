/**
 * The gauges of THIS machine for the tray and the Processes view: CPU, memory,
 * disk, network and the pending-restart flag. Every Topics server answers it
 * (`GET /api/system/machine-metrics`) so the machine that shows a node asks the
 * node the same question the node would answer about itself.
 *
 * A reading the OS does not give is null: a dash on screen, never a made-up 0.
 */
import os from "node:os";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import type { MachineMetrics } from "../../shared/machine-overview";
import { machineSharesNow } from "../services/dispatch-capacity";
import { machineCores } from "./machine-cores";

const REBOOT_FLAG = "/var/run/reboot-required";

interface NetCounters { at: number; rx: number; tx: number }
let lastNet: NetCounters | null = null;

/** Sum of rx/tx bytes over the real interfaces of a /proc/net/dev text. */
export function parseProcNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/.exec(line);
    if (!m || m[1] === "lo") continue;
    rx += Number(m[2]);
    tx += Number(m[3]);
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

/**
 * Memory in use of a node that cannot read its own, from its process list (`machine-readout`): the memory of
 * every process over the machine total. Under-counts the kernel and its caches, but it is a real reading, not a gap.
 */
export function memPctFromReadout(readout: { memTotalMB?: number | null; procs?: Array<{ memMB: number }>; rest?: { memMB: number } } | null): number | null {
  const total = readout?.memTotalMB;
  if (!readout || typeof total !== "number" || total <= 0 || !Array.isArray(readout.procs)) return null;
  // The readout is JSON from another node: keep only entries whose memMB is a finite number.
  const values = [...readout.procs, readout.rest].map((p) => (p as { memMB?: unknown } | null | undefined)?.memMB);
  const numeric = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (numeric.length === 0) return null;
  const usedMB = numeric.reduce((sum, v) => sum + v, 0);
  return Math.min(100, Math.round((usedMB / total) * 1000) / 10);
}

/**
 * Memory in use, in percent, from a `/proc/meminfo` text: what the machine cannot give back without
 * swapping is total minus `MemAvailable` (the kernel's own estimate, cache already counted as free).
 * `null` when either line is missing: not measured, never 0.
 */
export function parseProcMemoryPct(text: string): number | null {
  const kb = (name: string): number | null => {
    const n = Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);
    return Number.isFinite(n) ? n : null;
  };
  const total = kb("MemTotal");
  const avail = kb("MemAvailable");
  if (total === null || avail === null || total <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, (1 - avail / total) * 100)));
}

/**
 * Memory in use of THIS machine, in percent, for the gauge and the 24 hour chart.
 *
 * macOS keeps the dispatch gate's own reading (`vm_stat`, stricter than a gauge needs). Off macOS the gate
 * has no probe on purpose (a floor made of an unverified conversion would stop work), but a GAUGE can say what
 * the OS says: Linux `/proc/meminfo`, Windows `os.freemem()` (there it is the available physical memory, not
 * a cache-blind "free" like on macOS). Before this, a Linux node showed CPU and a dash for memory.
 */
export function readMemPct(
  gate: number | null,
  platform: NodeJS.Platform = process.platform,
  readProcMemory: () => string = () => readFileSync("/proc/meminfo", "utf8"),
  total: number = os.totalmem(),
  free: number = os.freemem(),
): number | null {
  if (gate !== null) return gate;
  try {
    if (platform === "linux") return parseProcMemoryPct(readProcMemory());
    if (platform === "win32" && total > 0) return Math.round(Math.min(100, Math.max(0, (1 - free / total) * 100)));
  } catch { /* no procfs: not measured */ }
  return null;
}

function netRates(now: number): { inBps: number | null; outBps: number | null } {
  if (process.platform !== "linux") return { inBps: null, outBps: null };
  let counters: { rx: number; tx: number } | null = null;
  try { counters = parseProcNetDev(readFileSync("/proc/net/dev", "utf8")); } catch { /* no procfs */ }
  if (!counters) return { inBps: null, outBps: null };
  const prev = lastNet;
  lastNet = { at: now, ...counters };
  if (!prev || now - prev.at < 1000) return { inBps: null, outBps: null };
  const s = (now - prev.at) / 1000;
  return { inBps: Math.max(0, (counters.rx - prev.rx) / s), outBps: Math.max(0, (counters.tx - prev.tx) / s) };
}

function diskPct(): number | null {
  try {
    const s = statfsSync(process.platform === "win32" ? (process.env.SystemDrive ?? "C:") + "\\" : "/");
    const total = s.blocks * s.bsize;
    return total > 0 ? Math.round(((total - s.bavail * s.bsize) / total) * 100) : null;
  } catch { return null; }
}

export function readLocalMetrics(now = Date.now()): MachineMetrics {
  let shares: { machineCpuPct: number | null; machineMemPct: number | null } = { machineCpuPct: null, machineMemPct: null };
  try { shares = machineSharesNow(); } catch { /* not measured, never zero */ }
  const totalGB = os.totalmem() / 1e9;
  const memPct = readMemPct(shares.machineMemPct);
  const net = netRates(now);
  return {
    cpuPct: shares.machineCpuPct,
    memPct,
    memUsedGB: memPct === null ? null : (memPct / 100) * totalGB,
    memTotalGB: totalGB,
    diskPct: diskPct(),
    netInBps: net.inBps,
    netOutBps: net.outBps,
    uptimeSec: Math.round(os.uptime()),
    rebootRequired: process.platform === "linux" ? existsSync(REBOOT_FLAG) : null,
    cores: machineCores(),
  };
}
