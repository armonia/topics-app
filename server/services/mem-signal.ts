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
 * reads the machine itself - the only IO is `fileMemSampleStore`, the disk the
 * window is parked on across a restart, and it is injected.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
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
 * `[memsig]` line a minute:
 *
 *     swapin/s 170.1 debt +0.7 swapUsed 14.8 -> sustained
 *     swapin/s 167.7 debt -1.7 swapUsed 15.2 -> CALM
 *     swapin/s  64.1 debt -1.2 swapUsed 15.4 -> CALM
 *     swapin/s  36.3 debt -0.1 swapUsed 15.3 -> CALM
 *     swapin/s  27.8 debt +0.1 swapUsed 15.1 -> CALM
 *
 * Eleven lines of those 40 minutes read at least 10 pages/s back from disk and
 * only two were called sustained: with the swap full the debt oscillates around
 * zero, so the WORST state the machine reaches is the one the AND lets through,
 * and neither the checks brake nor the freezer can ever fire when they are
 * needed. The reading was already in the probe's hands and thrown away -
 * `sysctl -n vm.swapusage` prints `total` next to `used`.
 *
 * 0.9 IS PROVISIONAL AND IT IS NOT MEASURED, written down here because the
 * first version of this comment claimed the opposite. `total` was NEVER in the
 * log: `[memsig]` printed `swapUsedGB` alone, so the shares above are
 * `used / 16384`, a denominator assumed and not read. And it moved - 39 of the
 * 869 lines of 15-16/09 print `swapUsedGB` ABOVE 16.384, up to 17.2 GB at
 * 12:46:59, eleven minutes after the last line of the table, so by then macOS
 * had grown the file to at least 17408 MB. `/System/Volumes/VM` holds files of
 * exactly 1 GiB: the denominator moves in 1 GB steps, which is 5.5 points of
 * share at used = 15 GB against the 0.3 points of margin of the lowest line
 * above. Had the 17th file already been there at 12:22, those five lines would
 * read 85.0-88.5% and this door would open on none of them. `swapTotalGB` is in
 * the line from today for exactly that reason: the share is calibrated on read
 * numbers after a few days of log, not before.
 *
 * WHAT THE DOOR COSTS, counted over all 874 lines of the live log that carry
 * the three fields (denominator assumed at 16384): the AND alone called 68 of
 * them sustained, the OR calls 170. Against "at least 50 pages/s read back" as
 * the thrash the brief names, precision goes 44% -> 32% and recall 39% -> 70%,
 * and the longest unbroken episode goes from 4 minutes to 19 - which is why the
 * checks brake now has a way out (`review-checks-brakes.ts`). It held nothing in
 * that log: all 874 lines print `inFlight=0 checkRuns=0`, so there was never a
 * check tree to brake or a tree to freeze in the minutes this door was written
 * for. The board was stopped upstream, by the admission floor.
 *
 * WHAT IT STILL MISSES: 23 lines reading 50-438 pages/s sit UNDER the ceiling
 * (12.3-14.7 GB used) and stay calm, the heaviest minute of the whole log among
 * them (438.6 pages/s at 08:43:02, debt +0.0). A third term on the read-back
 * rate alone would take them and is deliberately NOT here: this log holds no
 * reading of a HEALTHY machine above 10 pages/s, so its threshold would be a
 * second uncalibrated number propping up the first.
 *
 * THE TWO TERMS HAND OFF and that is why neither is enough alone. When macOS
 * grows the swap file the total rises, the share drops below the ceiling - and
 * in the same breath `used` climbs, which is the debt term. When growth stops
 * because there is nothing left to grow into, the debt flattens and the share
 * is at the ceiling. Swap turned off (`total = 0`), an unreadable line or the
 * first samples after a reboot leave the share `null`, which is not zero and
 * not one: the term simply does not vote, and the rule falls back to the debt.
 *
 * A FALLING DEBT DOES NOT VETO THE CEILING, and that is a decision and not an
 * oversight. The two minutes that read most like recovery - 12:22 at -1.7 and
 * 12:48 at -4.1 - sit INSIDE an episode that is sustained in the minute before
 * AND in the minute after (12:21 +0.7 at 170.1/s, 12:46 +1.7 at 284.0/s, 12:49
 * +0.8 at 171.7/s): a compressor losing 4.5 GB in one minute there is a process
 * dying under the pressure, not the pressure ending. Recovery that really is
 * recovery reads BELOW the ceiling and stays calm on the share alone (M5b: 65
 * pages/s at 65.8% of the file).
 */
export const SWAP_CEILING_SHARE = 0.9;

/**
 * TWO DOORS, NOT ONE, because they see different minutes and the live log says
 * so. The rate-only door below (200 pages/s with the debt not shrinking) lets in
 * 16/09 14:41 - 956 pages/s, debt +0.4. The ceiling door takes 12:22:24 - 167.7
 * pages/s, debt -1.7, file 92% full - which the rate door refuses twice over
 * (under 200, and the debt negative). The ceiling door also asks for
 * PERSISTENCE, the window before it at 10 pages/s or more, and that is what
 * keeps out 12:54:29: an isolated 718.5 pages/s spike between two quiet minutes
 * (6.6 and 21.2) while the machine was giving memory back, swap 16.7 -> 15.4 GB.
 * A door that fires on one sample brakes a Mac that is emptying itself;
 * "sustained" has to mean sustained.
 */

/** The rate that says thrash by itself, as long as the debt is not shrinking. */
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
  // PERSISTENCE, for the ceiling door only: the rate of the window BEFORE this
  // one. A single spike between two quiet minutes is a machine giving memory
  // back, not a machine drowning - 16/09 12:54:29 read 718.5 pages/s between 6.6
  // and 21.2 while swap went 16.7 -> 15.4 GB. `null` when there is not enough
  // history yet, and then the ceiling door stays shut: at boot nothing is known.
  const before = [...run].reverse().find((sm) => sm.at <= base.at - SWAP_WINDOW_MS);
  const heldRatePerS = before != null && before.swapins != null && base.swapins != null && base.swapins >= before.swapins
    ? (base.swapins - before.swapins) / Math.max(1, (base.at - before.at) / 1000)
    : null;
  return {
    sustained: (pagesReadBackPerS >= PAGES_READ_BACK_PER_S && debtGBPerMin >= DEBT_GB_PER_MIN)
      || (pagesReadBackPerS >= PAGES_READ_BACK_HARD_PER_S && debtGBPerMin >= 0)
      || (pagesReadBackPerS >= PAGES_READ_BACK_PER_S && atCeiling && heldRatePerS != null && heldRatePerS >= PAGES_READ_BACK_PER_S),
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

/**
 * WHERE THE WINDOW SURVIVES A RESTART. Two calls, so a test can hold it in a
 * variable and the server can point it at a file.
 */
export interface MemSampleStore {
  read(): string | null;
  write(text: string): void;
}

interface MemSampleFile { v: 1; samples: MemSample[] }

/**
 * THE 2-MINUTE WINDOW OUTLIVES THE PROCESS, because on this machine the process
 * does not outlive two minutes.
 *
 * `TOPICS_SERVER_WATCH=1` restarts the server on every save under `server/`, and
 * the sample list was born empty in the new process: for 120 s `heldMemory()`
 * answered `null` and every admission and every resume was held, on a free Mac
 * exactly as on a full one. Measured on 25.7 h of 16-17/09/2026: 28 windows
 * zeroed across 44 restarts, about 56 minutes a day of queue stopped for a
 * reason that was not memory.
 *
 * THE RELOAD APPLIES THE SAME CUT AS TWO LIVE SAMPLES (`MEM_SAMPLE_GAP_MS`, 30
 * s) and it does so for free: `newestRun` already breaks on a hole bigger than
 * the gap and on a newest sample older than it, measured against `now`. A
 * process back up in three seconds inherits a valid window; one back after ten
 * minutes starts from zero exactly as today. The rule "I do not start on a
 * single reading" is untouched - what is restored is readings, not a verdict.
 *
 * WRITTEN AT EVERY SAMPLE, and the alternative is what makes it necessary. The
 * file is ~17 samples of about 120 bytes, some 2 KB, tmp + rename, no fsync (a
 * sample lost to a machine crash costs a warm-up, which is what happens today
 * anyway; an fsync every 10 s on the disk the floor is there to protect is the
 * wrong trade). Throttling the write to 30 s instead would leave the newest
 * persisted sample up to 30 s old at the restart, and the reload cut would then
 * drop it in exactly the case this exists for - the three-second restart.
 */
export function createMemSignal(deps: {
  probe: () => Promise<Omit<MemSample, "at"> | null>;
  now?: () => number;
  measurable: boolean;
  /** Absent = nothing survives the restart, the behaviour before KANBAN-82. */
  store?: MemSampleStore;
}): MemSignal {
  const now = deps.now ?? Date.now;
  const list: MemSample[] = loadSamples(deps.store, now());
  let inFlight: Promise<void> | null = null;
  const persist = () => {
    if (!deps.store) return;
    try { deps.store.write(JSON.stringify({ v: 1, samples: list } satisfies MemSampleFile)); }
    catch { /* the window still works in memory: a store that cannot write must not stop the beat */ }
  };
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
          persist();
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

/**
 * The samples left by the previous process, or an empty list.
 *
 * Three things are dropped here and nothing else is judged: anything older than
 * `KEEP_MS` (the list's own horizon), anything dated in the FUTURE (a clock that
 * moved back would otherwise pin `newestRun` on a sample that never ages), and
 * a file that does not parse. The 30 s gap is NOT applied here: it belongs to
 * `heldMemory`, which reads it against the instant of the question, not the
 * instant of the boot.
 */
function loadSamples(store: MemSampleStore | undefined, now: number): MemSample[] {
  if (!store) return [];
  try {
    const raw = store.read();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<MemSampleFile>;
    if (!Array.isArray(parsed.samples)) return [];
    return parsed.samples
      .filter((s): s is MemSample => !!s && typeof s.at === "number" && Number.isFinite(s.at)
        && s.at <= now && s.at >= now - KEEP_MS)
      .sort((a, b) => a.at - b.at);
  } catch { return []; }
}

/**
 * The production store: one small JSON file under the state dir, tmp + rename.
 *
 * The state dir and not `~/.topics`: a test server and the production server
 * must not share the window, for the same reason they do not share the DB, and
 * `resolveStateDir` is the one door that already answers that (it is where
 * `swap-freeze.json` and `provider-hold.json` live). Not a DB row either - this
 * is machine telemetry with a 180 s lifetime, and rewriting a row every 10 s
 * would put that churn in the WAL every other service reads, on top of needing
 * the DB open before the first sample, which at boot it is not.
 *
 * WHICH MEANS IT LANDS IN THE REPO ROOT IN PRODUCTION, because `start-prod.sh`
 * runs from there and nothing exports `DATA_DIR`, so the fallback is the cwd -
 * exactly where `provider-hold.json` already sits. That is why this file and
 * its `.tmp` have their own two lines in `.gitignore`, with the reason written
 * beside them: on 17/09/2026 two UNTRACKED files in that root held the door shut
 * on every land the board attempted, and `scripts/check-e2e-touched.ts` still
 * sums untracked files into the changed ones. An untracked file rewritten every
 * ten seconds is not something to leave outside the ignore list.
 */
export function fileMemSampleStore(path: string): MemSampleStore {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    },
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
 * `+0.7`, `-1.9`, `?`: the ONE place a signed number gets its sign.
 *
 * Every line that explains a sustained verdict used to hard-code the `+`, which
 * was true only while `sustained` implied a debt of at least +0.5 GB/min. The
 * ceiling door removes that invariant - the typical sustained minute of the
 * live log has a NEGATIVE debt - and four lines started printing `+-1.9`.
 */
export function signed(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function oneDecimal(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "?" : n.toFixed(1);
}

function sharePct(v: SwapVerdict): string {
  return v.swapPct == null ? "?" : `${(v.swapPct * 100).toFixed(1)}%`;
}

/**
 * The signs of a sustained verdict, for the ENGLISH log lines, in one place.
 *
 * The share is in it because since the ceiling became a door it is half the
 * verdict: a line that explains a wait and names only the debt explains a wait
 * that is not the one happening.
 */
export function swapSigns(v: SwapVerdict): string {
  return `swapins ${oneDecimal(v.pagesReadBackPerS)}/s, memory debt ${signed(v.debtGBPerMin)} GB/min, swap file ${sharePct(v)} full`;
}

/**
 * The same verdict for the notes the OWNER reads on a card, in Italian like
 * every other board note, and naming the term that actually fired: with the
 * debt growing the machine is taking on memory it cannot hold, with the debt
 * flat or falling the reason is the full swap file, and "debito +-1.9 GB/min"
 * was neither of the two.
 */
export function swapReasonIt(v: SwapVerdict): string {
  const pages = oneDecimal(v.pagesReadBackPerS);
  return v.debtGBPerMin != null && v.debtGBPerMin >= DEBT_GB_PER_MIN
    ? `il Mac è in swap da un minuto (${pages} pagine/s rilette dal disco, debito di memoria ${signed(v.debtGBPerMin)} GB/min)` // allow-italian: board notes are written in Italian like every other service comment
    : `il Mac ha il file di swap pieno al ${sharePct(v)} e rilegge ${pages} pagine/s dal disco (debito ${signed(v.debtGBPerMin)} GB/min)`; // allow-italian: board notes are written in Italian like every other service comment
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
    `swapTotalGB=${f(l?.swapTotalMB == null ? null : l.swapTotalMB / 1000)}`,
    // The DENOMINATOR of the next field, and the reason it is here: the share
    // that decides half the verdict was never logged, so nobody could tell a
    // machine filling up from macOS having added a 1 GB file under it.
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
