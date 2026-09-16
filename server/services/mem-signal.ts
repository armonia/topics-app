/**
 * ONE MEMORY SIGNAL WITH A HISTORY, shared by the admission floor, the budget
 * axis, the checks waiter and the swap brake.
 *
 * WHY. Every memory brake read one synchronous `vm_stat` instant, and
 * `availableMemGB` is 90% file-backed pages: under thrash it sits at 3.3-5.7 GB
 * and jumps when a process tree exits (14.5 GB with 12 GB of swap on
 * 15/09/2026). The floor reopened on such a reading three times that morning and
 * held again within 19-115 s. A window answers what an instant cannot: the
 * LOWEST reading of the last 2 minutes, and whether the machine is still adding
 * memory debt while it reads pages back from disk.
 *
 * The functions here are pure over a list of samples; `createMemSignal` keeps
 * the list, fed on the dispatcher's 10 s beat by an async probe. Nothing here
 * reads the machine itself.
 */

import { memoryOwnersLogField, type MemoryFamily } from "./memory-owners";

export interface MemSample {
  /** Epoch ms when the probe answered. */
  at: number;
  /** The sum `availableMemGB` returns. */
  availGB: number | null;
  /** Cumulative, `vm_stat` "Swapins:". */
  swapins: number | null;
  /** `vm_stat` "Pages occupied by compressor:". */
  compressorPages: number | null;
  pageSize: number | null;
  /** `sysctl -n vm.swapusage`, "used = N M". */
  swapUsedMB: number | null;
  /**
   * `sysctl -n vm.swapusage`, "total = N M": how big macOS has grown the swap
   * file so far. Read from the SAME line as `swapUsedMB` and kept, because the
   * share of the two is the only term that separates a machine at its ceiling
   * from a calm one when the debt has stopped growing (see `swapVerdict`).
   */
  swapTotalMB: number | null;
  load1: number;
}

export interface HeldMemory {
  /** false off macOS: memory never blocks (the old `null` rule). */
  measurable: boolean;
  /** Newest reading, if it is at most 30 s old. */
  latestGB: number | null;
  /** LOWEST reading over the 120 s window; `null` while the window is not full. */
  heldGB: number | null;
  /** Contiguous coverage ending now. */
  coveredMs: number;
}

export interface SwapVerdict {
  sustained: boolean;
  pagesReadBackPerS: number | null;
  /** (delta compressor + delta swap used) over the window, per minute. */
  debtGBPerMin: number | null;
  /** `used / total` of the newest swap reading, 0..1; `null` with no swap file or no reading. */
  swapPct: number | null;
  coveredMs: number;
}

/** The shortest window the 15/09 log proves enough: the 10:37 spike lasted at most ~124 s. */
export const MEM_WINDOW_MS = 120_000;
/** A hole longer than this empties the window: the loop stalled (29.8-145.9 s stalls, all under thrash). */
export const MEM_SAMPLE_GAP_MS = 30_000;
export const SWAP_WINDOW_MS = 60_000;
/**
 * Provisional thresholds, from live probes (design "Tornata 3", §2): thrash at
 * 14:06 read 12.8-33.6 swap-ins/s with debt growing +8.8 to +14 GB/min; recovery
 * at 11:23 read 65/s with debt shrinking; calm with swap debt at 14:50 read
 * 2.4-3.2/s, flat; a healthy board 0.04/s.
 */
export const PAGES_READ_BACK_PER_S = 10;
export const DEBT_GB_PER_MIN = 0.5;
/**
 * THE SECOND DOOR: A SWAP FILE AT ITS CEILING, because a debt that cannot grow
 * any more reads exactly like a debt that is not growing.
 *
 * Measured on the live server on 16/09/2026 between 11:50 and 12:35, one
 * `[memsig]` line a minute, swap total 16384 MB throughout:
 *
 *     swapin/s 170.1 debt +0.7 swapUsed 14.8 (90.3%) -> sustained
 *     swapin/s 167.7 debt -1.7 swapUsed 15.2 (92.8%) -> CALM
 *     swapin/s  64.1 debt -1.2 swapUsed 15.4 (94.0%) -> CALM
 *     swapin/s  36.3 debt -0.1 swapUsed 15.3 (93.4%) -> CALM
 *     swapin/s  27.8 debt +0.1 swapUsed 15.1 (92.2%) -> CALM
 *
 * Eleven lines of those 40 minutes read at least 10 pages/s back from disk and
 * only two were called sustained: with the swap full the debt oscillates around
 * zero, so the WORST state the machine reaches is the one the AND lets through,
 * and neither the checks brake nor the freezer can ever fire when they are
 * needed. The reading was already in the probe's hands and thrown away -
 * `sysctl -n vm.swapusage` prints `total` next to `used`.
 *
 * So the debt term gets an OR: the debt is GROWING, or the swap is already
 * full. 0.9 and not lower because with an OR the loose first term carries the
 * whole weight of the door alone: the sick readings above sit at 90.3-94.0%
 * and this machine read 96.5% while the queue was stuck, while a machine with
 * headroom is asked to prove a full minute at 10 pages/s before the share is
 * even looked at (a healthy board reads 0.04-3 pages/s; on this sick Mac 49 of
 * 60 lines were still under 10).
 *
 * THE TWO TERMS HAND OFF and that is why neither is enough alone. When macOS
 * grows the swap file the total rises, the share drops below the ceiling - and
 * in the same breath `used` climbs, which is the debt term. When growth stops
 * because there is nothing left to grow into, the debt flattens and the share
 * is at the ceiling. Swap turned off (`total = 0`), an unreadable line or the
 * first samples after a reboot leave the share `null`, which is not zero and
 * not one: the term simply does not vote, and the rule falls back to the debt.
 */
export const SWAP_CEILING_SHARE = 0.9;
/** Samples older than this are dropped: the longest question asked is 120 s. */
const KEEP_MS = 180_000;

/** The newest contiguous run of samples ending now (gaps at most 30 s, newest at most 30 s old). */
function newestRun(samples: readonly MemSample[], now: number, ok: (s: MemSample) => boolean): MemSample[] {
  const run: MemSample[] = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (!ok(s)) break;
    const next = run[0];
    if (next ? next.at - s.at > MEM_SAMPLE_GAP_MS : now - s.at > MEM_SAMPLE_GAP_MS) break;
    run.unshift(s);
  }
  return run;
}

export function heldMemory(samples: readonly MemSample[], now: number, measurable: boolean): HeldMemory {
  if (!measurable) return { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 };
  const run = newestRun(samples, now, (s) => s.availGB != null);
  if (run.length === 0) return { measurable: true, latestGB: null, heldGB: null, coveredMs: 0 };
  const coveredMs = Math.max(0, now - run[0]!.at);
  const latestGB = run[run.length - 1]!.availGB;
  let boundary = -1;
  for (let i = run.length - 1; i >= 0; i--) {
    if (run[i]!.at <= now - MEM_WINDOW_MS) { boundary = i; break; }
  }
  if (boundary < 0) return { measurable: true, latestGB, heldGB: null, coveredMs };
  const heldGB = Math.min(...run.slice(boundary).map((s) => s.availGB!));
  return { measurable: true, latestGB, heldGB, coveredMs };
}

export function swapVerdict(samples: readonly MemSample[], now: number): SwapVerdict {
  const run = newestRun(samples, now, () => true);
  const last = run[run.length - 1];
  // Used and total from the SAME reading. macOS grows the swap file while the
  // window runs, so a share built from two reads would move for a reason that
  // is not the machine filling up.
  const swapPct = last && last.swapUsedMB != null && last.swapTotalMB != null && last.swapTotalMB > 0
    ? last.swapUsedMB / last.swapTotalMB
    : null;
  const none: SwapVerdict = { sustained: false, pagesReadBackPerS: null, debtGBPerMin: null, swapPct, coveredMs: run.length ? now - run[0]!.at : 0 };
  const base = [...run].reverse().find((s) => s.at <= now - SWAP_WINDOW_MS);
  if (!last || !base || last === base) return none;
  const seconds = (last.at - base.at) / 1000;
  if (seconds <= 0) return none;
  const fields = [base.swapins, last.swapins, base.compressorPages, last.compressorPages, base.swapUsedMB, last.swapUsedMB, last.pageSize];
  if (fields.some((f) => f == null)) return none;
  // A counter that went down is a reboot between the two, not a rate.
  if (last.swapins! < base.swapins!) return none;
  const pagesReadBackPerS = (last.swapins! - base.swapins!) / seconds;
  const debtGB = ((last.compressorPages! - base.compressorPages!) * last.pageSize!) / 1e9 + (last.swapUsedMB! - base.swapUsedMB!) / 1000;
  const debtGBPerMin = (debtGB * 60) / seconds;
  const atCeiling = swapPct != null && swapPct >= SWAP_CEILING_SHARE;
  return {
    sustained: pagesReadBackPerS >= PAGES_READ_BACK_PER_S && (debtGBPerMin >= DEBT_GB_PER_MIN || atCeiling),
    pagesReadBackPerS, debtGBPerMin, swapPct, coveredMs: none.coveredMs,
  };
}

export interface MemSignal {
  sample(): Promise<void>;
  held(): HeldMemory;
  swap(): SwapVerdict;
  latestAvailGB(): number | null;
  samples(): readonly MemSample[];
}

export function createMemSignal(deps: {
  probe: () => Promise<Omit<MemSample, "at"> | null>;
  now?: () => number;
  measurable: boolean;
}): MemSignal {
  const now = deps.now ?? Date.now;
  const list: MemSample[] = [];
  let inFlight: Promise<void> | null = null;
  return {
    // Single-flight: under thrash a fork takes seconds, and the 10 s beat would
    // otherwise stack probes on the machine that is already short of memory.
    sample() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const got = await deps.probe();
          // A failed probe pushes nothing: the hole is the signal.
          if (!got) return;
          const at = now();
          list.push({ ...got, at });
          while (list.length && list[0]!.at < at - KEEP_MS) list.shift();
        } catch { /* same as a failed probe */ } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    held: () => heldMemory(list, now(), deps.measurable),
    swap: () => swapVerdict(list, now()),
    latestAvailGB: () => heldMemory(list, now(), deps.measurable).latestGB,
    samples: () => list,
  };
}

/** `sysctl -n vm.swapusage`: "total = 11264.00M  used = 10030.25M  free = 1233.75M  (encrypted)". */
export function parseSwapUsedMB(out: string): number | null {
  const n = Number(out.match(/used = ([\d.]+)M/)?.[1] ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * The `total` of the same line: the size of the swap file macOS has grown, in MB.
 *
 * Zero is a real answer and it is NOT "unknown": a machine with swap turned off
 * prints `total = 0.00M`, and `swapVerdict` must read that as "no ceiling to be
 * at", never as a division by zero (which would make the share `Infinity` and
 * pin the second door open for ever).
 */
export function parseSwapTotalMB(out: string): number | null {
  const n = Number(out.match(/total = ([\d.]+)M/)?.[1] ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * The instrument line, every 60 s, idle included: it gates nothing, and it is
 * what the thresholds above and the outcome bar are measured with.
 */
export function formatMemorySignalLine(i: {
  at: number;
  held: HeldMemory;
  swap: SwapVerdict;
  latest: MemSample | null;
  inFlight: number;
  checkRuns: number;
  heaviestCheckGB: number | null;
  /** Agent trees the swap freezer is holding stopped right now, and their footprint. */
  frozenTrees?: number;
  frozenGB?: number | null;
  /** Who is holding memory OUTSIDE Topics, heaviest first (`memory-owners.ts`). */
  foreign?: readonly MemoryFamily[];
}): string {
  const f = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? "?" : n.toFixed(digits));
  const signed = (n: number | null) => (n == null || !Number.isFinite(n) ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}`);
  const l = i.latest;
  const compressorGB = l?.compressorPages != null && l.pageSize ? (l.compressorPages * l.pageSize) / 1e9 : null;
  return [
    `${new Date(i.at).toISOString()} [memsig]`,
    `avail=${f(i.held.latestGB)}`,
    `held2m=${f(i.held.heldGB)}`,
    `cover=${Math.round(i.held.coveredMs / 1000)}s`,
    `swapin/s=${f(i.swap.pagesReadBackPerS)}`,
    `debt/min=${signed(i.swap.debtGBPerMin)}`,
    `comprGB=${f(compressorGB)}`,
    `swapUsedGB=${f(l?.swapUsedMB == null ? null : l.swapUsedMB / 1000)}`,
    `swapPct=${f(i.swap.swapPct == null ? null : i.swap.swapPct * 100)}`,
    `load1=${f(l?.load1)}`,
    `swap=${i.swap.sustained ? "sustained" : "calm"}`,
    `inFlight=${i.inFlight}`,
    `checkRuns=${i.checkRuns}`,
    `heaviestCheckGB=${f(i.heaviestCheckGB)}`,
    `frozen=${i.frozenTrees ?? 0}`,
    `frozenGB=${f(i.frozenGB ?? 0)}`,
    `altri=${memoryOwnersLogField(i.foreign ?? [])}`,
  ].join(" ");
}
