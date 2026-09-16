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
 * The second door, for the case the first one cannot see: pages read back this
 * fast while the debt is merely NOT SHRINKING. Measured live on 16/09 at 14:41
 * with the board idle and nothing of ours running: 956 pages a second, load
 * 92.7, swap 15.5 GB of 16, compressor 15.1 GB, debt +0.4 GB/min, and the
 * verdict said "calm" because it wanted +0.5.
 *
 * The rate alone is NOT enough, and the same log says why: over 953 [memsig]
 * lines there are five recoveries above 200 pages/s with the debt flat or
 * shrinking, the fastest 718.5/s at -0.4 GB/min (16/09 12:54). A rate gate
 * alone would have braked a Mac that was emptying itself. A debt that is not
 * shrinking is what tells the two apart: it holds every one of those five out
 * and lets 14:41 in.
 */
export const PAGES_READ_BACK_HARD_PER_S = 200;
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
  const none: SwapVerdict = { sustained: false, pagesReadBackPerS: null, debtGBPerMin: null, coveredMs: run.length ? now - run[0]!.at : 0 };
  const last = run[run.length - 1];
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
  return {
    sustained: (pagesReadBackPerS >= PAGES_READ_BACK_PER_S && debtGBPerMin >= DEBT_GB_PER_MIN)
      || (pagesReadBackPerS >= PAGES_READ_BACK_HARD_PER_S && debtGBPerMin >= 0),
    pagesReadBackPerS, debtGBPerMin, coveredMs: none.coveredMs,
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
    `load1=${f(l?.load1)}`,
    `swap=${i.swap.sustained ? "sustained" : "calm"}`,
    `inFlight=${i.inFlight}`,
    `checkRuns=${i.checkRuns}`,
    `heaviestCheckGB=${f(i.heaviestCheckGB)}`,
    `frozen=${i.frozenTrees ?? 0}`,
    `frozenGB=${f(i.frozenGB ?? 0)}`,
  ].join(" ");
}
