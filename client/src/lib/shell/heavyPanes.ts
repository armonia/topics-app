/**
 * Which native browser panes are HEAVY: a page that keeps burning CPU while
 * nobody interacts with it.
 *
 * WHAT IT READS. The shell's `perf_metrics` payload carries one row per webview
 * (`webviews`: label, pid, cpu_percent per core). Those rows reach this module
 * from the reader that already polls the shell (`usePerfMetrics`, the status
 * bar every 5 s), plus one fallback timer per document that hosts panes and has
 * no such reader (pop-outs, group windows).
 *
 * WHY TIME AND NOT A SAMPLE COUNT. Readers poll at different cadences (status
 * bar 5 s, dropdown 1.5 s) and the shell serves every reader inside its 2 s
 * window the same cached sample. A rule written in samples would call a pane
 * heavy sooner whenever the dropdown is open. A rule written as "every counting
 * sample above the line for 10 s" reaches the same verdict at the same instant
 * whatever the cadence.
 *
 * WHAT COUNTS. A sample describes the interval since the previous real sample,
 * up to ~8 s back. So it counts only once the pane has been shown and unpaused
 * for that long (otherwise the interval may contain hidden or paused time), not
 * while the page is loading and not right after a navigation, where CPU is a
 * load and not an animated page.
 *
 * THE VERDICT IS STICKY WHILE PAUSED. A paused pane has no live interval to
 * judge, so nothing counts and nothing clears it; it is re-judged when live.
 * It is not persisted: a restart judges again.
 */
import { paneIdFromWebviewLabel } from '../paneUsage';

/** % of ONE core. 15/09: the animated :4600 page 16.9%, a quiet :4444 page 0.4%. */
export const HEAVY_CPU = 8;
export const HEAVY_SPAN_MS = 10_000;
/** Reader cadence 5 s + shell cache up to 2 s + 1 s. */
export const LIVE_COVER_MS = 8_000;
export const NAV_GRACE_MS = 10_000;
export const CLEAR_CPU = 3;
export const CLEAR_SPAN_MS = 55_000;
/** Fallback reader: cadence, and how recent another reader's sample must be to skip. */
const FALLBACK_MS = 5_000;
const FALLBACK_SKIP_MS = 4_000;

export interface ShellWebviewRow {
  label: string;
  pid: number;
  cpu_percent: number | null;
  /** Footprint of the WebContent process, MB. Only for the copy, never the verdict. */
  memory_mb?: number;
}

/** What the hook knows about its pane at the time a sample arrives. */
export interface PaneSampleContext {
  /** When the native view was last shown AND unpaused; null while it is not. */
  liveSince: number | null;
  loading: boolean;
  navigatedAt: number | null;
  /** origin + pathname: a new page is judged from scratch, an HMR reload is not. */
  urlKey: string;
}

interface Streak { start: number; values: number[] }

export interface PaneVerdictState {
  urlKey: string;
  heavy: boolean;
  /** Median CPU of the streak that made it heavy, for the copy. */
  cpu: number;
  streak: Streak | null;
  clearStreak: Streak | null;
}

export function initialVerdict(urlKey: string): PaneVerdictState {
  return { urlKey, heavy: false, cpu: 0, streak: null, clearStreak: null };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function extend(streak: Streak | null, at: number, cpu: number): Streak {
  return streak ? { start: streak.start, values: [...streak.values, cpu] } : { start: at, values: [cpu] };
}

/** One sample for one pane. Pure. */
export function stepVerdict(
  state: PaneVerdictState,
  cpu: number | null,
  receivedAt: number,
  ctx: PaneSampleContext,
): PaneVerdictState {
  const base = ctx.urlKey === state.urlKey ? state : initialVerdict(ctx.urlKey);
  const counts =
    ctx.liveSince !== null &&
    receivedAt - ctx.liveSince >= LIVE_COVER_MS &&
    !ctx.loading &&
    !(ctx.navigatedAt !== null && receivedAt - ctx.navigatedAt < NAV_GRACE_MS);
  if (!counts || cpu === null) {
    return base.streak || base.clearStreak ? { ...base, streak: null, clearStreak: null } : base;
  }
  if (!base.heavy) {
    if (cpu < HEAVY_CPU) return base.streak ? { ...base, streak: null } : base;
    const streak = extend(base.streak, receivedAt, cpu);
    if (receivedAt - streak.start >= HEAVY_SPAN_MS) {
      return { ...base, heavy: true, cpu: median(streak.values), streak: null, clearStreak: null };
    }
    return { ...base, streak };
  }
  if (cpu >= CLEAR_CPU) return base.clearStreak ? { ...base, clearStreak: null } : base;
  const clearStreak = extend(base.clearStreak, receivedAt, cpu);
  if (receivedAt - clearStreak.start >= CLEAR_SPAN_MS) return initialVerdict(base.urlKey);
  return { ...base, clearStreak };
}

/**
 * CPU per pane from one payload, or null for a pane that is present but not
 * attributable or not measured.
 *
 * A pid reported under two different panes, or under a pane and a label that is
 * not a pane (the main UI, a pop-out's UI), belongs to nobody: WebView2 panes
 * that share an environment, a WebKit process reused across views. Generations
 * of one pane (`browserpane-~1~<id>`) with distinct pids are summed, the rule of
 * `getBrowserPaneUsage`.
 */
export function attributeSample(rows: readonly ShellWebviewRow[]): Map<string, number | null> {
  const owners = new Map<number, Set<string>>();
  for (const row of rows) {
    const owner = paneIdFromWebviewLabel(row.label) ?? `label:${row.label}`;
    const set = owners.get(row.pid) ?? new Set<string>();
    set.add(owner);
    owners.set(row.pid, set);
  }
  const out = new Map<string, number | null>();
  const seenPids = new Map<string, Set<number>>();
  for (const row of rows) {
    const paneId = paneIdFromWebviewLabel(row.label);
    if (paneId === null) continue;
    if ((owners.get(row.pid)?.size ?? 0) > 1) {
      out.set(paneId, null);
      seenPids.set(paneId, new Set([-1]));
      continue;
    }
    const pids = seenPids.get(paneId) ?? new Set<number>();
    if (pids.has(-1) || pids.has(row.pid)) continue;
    pids.add(row.pid);
    seenPids.set(paneId, pids);
    const prev = out.get(paneId);
    if (prev === undefined) out.set(paneId, row.cpu_percent);
    else if (prev === null && row.cpu_percent === null) out.set(paneId, null);
    else out.set(paneId, (prev ?? 0) + (row.cpu_percent ?? 0));
  }
  return out;
}

// ── The store of this document ─────────────────────────────────────────────

/**
 * `cpu` is % of ONE core, the scale the thresholds above are calibrated on.
 * `memMb` is the pane's footprint at the last sample, when the shell gave it.
 * Neither is what a person reads: `machineShare` turns them into shares of
 * the Mac, which is the copy (23/09: «37% di un core» meant nothing).
 */
export interface HeavyVerdict { heavy: boolean; cpu: number; memMb?: number }

/** What a pane costs, as a share of the WHOLE machine: CPU over all its cores,
 *  memory over its physical RAM. `null` where the denominator is unknown. */
export function machineShare(
  v: { cpu: number; memMb?: number },
  machine: { cores: number; memMb: number | null },
): { cpuPct: number; memPct: number | null } {
  const cores = Math.max(1, machine.cores);
  return {
    cpuPct: v.cpu / cores,
    memPct: v.memMb != null && machine.memMb ? (v.memMb / machine.memMb) * 100 : null,
  };
}

/** Whole percent, but never a flat «0%» for something that is running. */
export function formatShare(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0';
  if (pct < 1) return '<1';
  return String(Math.round(pct));
}

const contexts = new Map<string, PaneSampleContext>();
const verdicts = new Map<string, PaneVerdictState>();
/** One object per heavy pane, replaced only when it changes: what
 *  `useSyncExternalStore` reads must keep its identity between reads. */
const published = new Map<string, HeavyVerdict>();
const listeners = new Map<string, Set<() => void>>();
let lastSampleAt = 0;

function emit(contextId: string): void {
  for (const fn of [...(listeners.get(contextId) ?? [])]) fn();
}

/** The hook says what it knows about its pane. Cheap: a map write. */
export function reportPaneContext(contextId: string, ctx: PaneSampleContext): void {
  contexts.set(contextId, ctx);
}

/** The pane is gone from this document: its verdict goes with it. */
export function forgetPane(contextId: string): void {
  contexts.delete(contextId);
  verdicts.delete(contextId);
  if (published.delete(contextId)) emit(contextId);
}

/** Physical RAM of the Mac as the shell reported it; null until it does. */
let systemMemMb: number | null = null;
export function noteSystemMemory(mb: number | null | undefined): void {
  if (typeof mb === 'number' && mb > 0) systemMemMb = mb;
}
export function machineMemoryMb(): number | null {
  return systemMemMb;
}

/** Footprint per pane, summed over its own processes (same attribution rule
 *  as the CPU: a pid shared with another label belongs to nobody). */
function memoryByPane(rows: readonly ShellWebviewRow[]): Map<string, number> {
  const owners = new Map<number, Set<string>>();
  for (const row of rows) {
    const owner = paneIdFromWebviewLabel(row.label) ?? `label:${row.label}`;
    const set = owners.get(row.pid) ?? new Set<string>();
    set.add(owner);
    owners.set(row.pid, set);
  }
  const out = new Map<string, number>();
  const seen = new Set<number>();
  for (const row of rows) {
    const paneId = paneIdFromWebviewLabel(row.label);
    if (paneId === null || typeof row.memory_mb !== 'number') continue;
    if ((owners.get(row.pid)?.size ?? 0) > 1 || seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.set(paneId, (out.get(paneId) ?? 0) + row.memory_mb);
  }
  return out;
}

export function noteWebviewSample(rows: readonly ShellWebviewRow[] | undefined, receivedAt: number): void {
  if (!rows) return;
  lastSampleAt = receivedAt;
  const byPane = attributeSample(rows);
  const memByPane = memoryByPane(rows);
  for (const [contextId, ctx] of contexts) {
    const prev = verdicts.get(contextId) ?? initialVerdict(ctx.urlKey);
    const cpu = byPane.get(contextId) ?? null;
    const next = stepVerdict(prev, cpu, receivedAt, ctx);
    verdicts.set(contextId, next);
    const memMb = memByPane.get(contextId);
    const shown = published.get(contextId);
    // Memory moves on every sample; the copy is rounded to whole percent, so a
    // new object only when that rounding would change (identity is what
    // `useSyncExternalStore` compares).
    const memMoved = next.heavy && memMb !== undefined
      && Math.round(memMb / 64) !== Math.round((shown?.memMb ?? -64) / 64);
    if (next.heavy === prev.heavy && (!next.heavy || (next.cpu === prev.cpu && !memMoved))) continue;
    if (next.heavy) published.set(contextId, { heavy: true, cpu: next.cpu, ...(memMb !== undefined ? { memMb } : shown?.memMb !== undefined ? { memMb: shown.memMb } : {}) });
    else published.delete(contextId);
    emit(contextId);
  }
}

/** Tests only: the module keeps per-document state. */
export function __resetHeavyPanesForTests(): void {
  contexts.clear();
  verdicts.clear();
  published.clear();
  systemMemMb = null;
  lastSampleAt = 0;
}

export function heavyVerdict(contextId: string): HeavyVerdict | null {
  return published.get(contextId) ?? null;
}

export function subscribeHeavyVerdict(contextId: string, fn: () => void): () => void {
  const set = listeners.get(contextId) ?? new Set<() => void>();
  set.add(fn);
  listeners.set(contextId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(contextId);
  };
}

/**
 * The fallback reader, one timer per document, alive while at least one pane of
 * this document holds it. It skips a tick when another reader delivered a
 * sample recently, so in `main` (where the status bar reads every 5 s) it
 * rarely asks the shell at all.
 */
let fallbackHolders = 0;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

export function holdSampleFallback(fetchRows: () => Promise<readonly ShellWebviewRow[] | undefined>): () => void {
  fallbackHolders += 1;
  if (!fallbackTimer) {
    fallbackTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - lastSampleAt < FALLBACK_SKIP_MS) return;
      void fetchRows().then((rows) => noteWebviewSample(rows, Date.now()), () => {});
    }, FALLBACK_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fallbackHolders -= 1;
    if (fallbackHolders === 0 && fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  };
}
