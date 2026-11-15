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
  const memPct = shares.machineMemPct;
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
