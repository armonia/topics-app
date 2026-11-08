/**
 * HOW BUSY THE WHOLE MAC'S CPU IS, as a percent of the machine (0-100).
 *
 * WHY A DEDICATED READING AND NOT THE FLEET PROBE. The fleet probe
 * (`fleet-usage.ts`) can also give a whole-machine figure, by adding ours,
 * the agents' scripts and `otherCpuPercent`. It was the other candidate and it
 * lost on three counts:
 *  - it is a SUM OF PROCESSES from `ps`, so whatever `ps` does not attribute
 *    (short-lived processes born and dead between two snapshots, the kernel's
 *    own time) is missing, and the sum can also exceed the machine under a
 *    scheduler at saturation (see `machineBudget`, which floors it);
 *  - it is `null` whenever its cache is older than 30 s, and on Windows always;
 *  - "others" is SMOOTHED for the gate (`smoothedOther`), which is right for a
 *    brake and wrong for a number a person compares with Activity Monitor.
 * The kernel's per-core tick counters (`os.cpus().times`) are what Activity
 * Monitor itself reads: busy ticks over all ticks between two readings is the
 * CPU% of the whole machine, with nothing to attribute and on every platform.
 *
 * The fleet sum is still used, but only as the FALLBACK for the one call that
 * has no previous tick reading to diff against (the first after boot) or when
 * `os.cpus()` comes back empty, which it does on macOS under heavy load (see
 * `machine-cores.ts`). Nothing measured at all is `null`, never 0%.
 */
import os from "node:os";

export interface CpuTicks {
  /** Sum over all cores of the non-idle ticks. */
  busy: number;
  /** Sum over all cores of every tick, idle included. */
  total: number;
}

/** Folds `os.cpus()` into two counters; `null` for an empty or unreadable list. */
export function sumTicks(cpus: ReadonlyArray<{ times: os.CpuInfo["times"] }> | null | undefined): CpuTicks | null {
  if (!cpus || cpus.length === 0) return null;
  let busy = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    const b = t.user + t.nice + t.sys + t.irq;
    busy += b;
    total += b + t.idle;
  }
  return total > 0 ? { busy, total } : null;
}

/**
 * Percent of the machine busy between two readings, or `null` when the pair
 * says nothing: no elapsed ticks, or counters that went backwards (a reading
 * with fewer cores, a counter reset). Clamped to 0-100.
 */
export function busyPctBetween(prev: CpuTicks | null, next: CpuTicks | null): number | null {
  if (!prev || !next) return null;
  const dTotal = next.total - prev.total;
  const dBusy = next.busy - prev.busy;
  if (!(dTotal > 0) || dBusy < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (dBusy / dTotal) * 100)));
}

/**
 * Two readings closer than this are not diffed: the counters move in
 * scheduler ticks, and over a few milliseconds one busy tick reads as 100%.
 * The last answer is repeated instead, which is what it still is.
 */
export const MIN_SPAN_MS = 1_000;

export interface MachineCpuSampler {
  (fallbackPct?: number | null): number | null;
}

/**
 * A sampler that remembers the previous tick reading. Every caller of the
 * capacity (the board poll every 15 s, the night tick, the terminal cap) moves
 * the baseline forward, so the figure covers the last interval between two
 * readings, whatever their cadence, and never the average since boot.
 */
export function createMachineCpuSampler(
  read: () => ReadonlyArray<{ times: os.CpuInfo["times"] }> | null = () => { try { return os.cpus(); } catch { return null; } },
  now: () => number = Date.now,
): MachineCpuSampler {
  let base: { ticks: CpuTicks; at: number; cores: number } | null = null;
  let last: number | null = null;
  return (fallbackPct = null) => {
    const cpus = read();
    const ticks = sumTicks(cpus);
    const at = now();
    if (!ticks) return last ?? clampPct(fallbackPct);
    const cores = cpus!.length;
    // A reading with a different core count (the short list macOS returns
    // under load) is not comparable with the base: diffing it would count a
    // whole core's since-boot ticks as the last interval. Restart from it.
    if (!base || base.cores !== cores) {
      base = { ticks, at, cores };
      return last ?? clampPct(fallbackPct);
    }
    if (at - base.at < MIN_SPAN_MS) return last ?? clampPct(fallbackPct);
    const pct = busyPctBetween(base.ticks, ticks);
    base = { ticks, at, cores };
    if (pct == null) return last ?? clampPct(fallbackPct);
    last = pct;
    return pct;
  };
}

function clampPct(p: number | null | undefined): number | null {
  if (p == null || !Number.isFinite(p)) return null;
  return Math.round(Math.min(100, Math.max(0, p)));
}

/** The process-wide sampler the capacity reading uses. */
export const machineCpuPct: MachineCpuSampler = createMachineCpuSampler();
