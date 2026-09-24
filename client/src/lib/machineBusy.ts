/**
 * HOW BUSY THE MAC IS, AS ONE NUMBER.
 *
 * Reported on 24/09: the resource screens still spoke of CPU, memory, cores and
 * gigabytes, and someone who is not technical cannot weigh two percentages
 * against each other, let alone core-units. So every surface that talks about
 * the machine's load says ONE thing: "the Mac is X% busy", in green, amber or
 * red. The two axes it is made of stay one click away, under "Details".
 *
 * WHY THE LARGER OF THE TWO AND NOT AN AVERAGE. CPU and memory do not
 * compensate: a Mac at 95% CPU and 20% memory is a busy Mac, and an average
 * would call it half idle. The same rule `loadTint.ts` already applies to the
 * status dot.
 *
 * NOT MEASURED IS NOT ZERO. One axis missing (memory off macOS, CPU before the
 * first reading) leaves the other as the answer; both missing is `null`, drawn
 * as "not measurable", never as a reassuring 0%.
 *
 * This module decides the number and its tone and nothing else: every surface
 * (board gauge, settings, the stop-N chip, night mode, the wait sentences, the
 * status dot, the performance panel, the heavy browser tab) imports it, so two
 * surfaces cannot disagree about the same Mac.
 */

/** Green below this. */
export const BUSY_AMBER_FROM = 60;
/** Red above this (85 itself is still amber). */
export const BUSY_RED_ABOVE = 85;

export type BusyTone = 'ok' | 'busy' | 'critical' | 'unknown';

const valid = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/** The larger of the two measured shares, unrounded; `null` when neither is. */
export function busiestPct(cpuPct: number | null | undefined, memPct: number | null | undefined): number | null {
  const parts = [cpuPct, memPct].filter(valid).map((n) => Math.min(100, Math.max(0, n)));
  return parts.length ? Math.max(...parts) : null;
}

/** What `machineBusyPct` reads: the capacity reading, or any other source of
 *  the two whole-Mac shares. The memory fallback fields exist because an older
 *  server sends `availableMemGB`/`totalMemGB` and not `machineMemPct`; memory
 *  from those is the same number. The CPU has no such fallback on purpose:
 *  `load1 / cores` is a run-queue length, not a CPU share. */
export interface MachineShares {
  machineCpuPct?: number | null;
  machineMemPct?: number | null;
  availableMemGB?: number | null;
  totalMemGB?: number;
}

/** Memory in use as a percent of the Mac, from the wire field or its inputs. */
export function machineMemPct(s: MachineShares | null | undefined): number | null {
  if (!s) return null;
  if (valid(s.machineMemPct)) return s.machineMemPct;
  if (valid(s.availableMemGB) && valid(s.totalMemGB) && s.totalMemGB > 0) {
    return Math.min(100, Math.max(0, (1 - s.availableMemGB / s.totalMemGB) * 100));
  }
  return null;
}

/** THE number: how busy the whole Mac is, 0-100 rounded, or `null`. */
export function machineBusyPct(s: MachineShares | null | undefined): number | null {
  const pct = busiestPct(s?.machineCpuPct, machineMemPct(s));
  return pct == null ? null : Math.round(pct);
}

export function busyTone(pct: number | null): BusyTone {
  if (pct == null) return 'unknown';
  if (pct > BUSY_RED_ABOVE) return 'critical';
  if (pct >= BUSY_AMBER_FROM) return 'busy';
  return 'ok';
}

/** Text colour per tone: the ring's own amber/rose, emerald for calm. */
export function busyTextClass(tone: BusyTone): string {
  if (tone === 'critical') return 'text-rose-300';
  if (tone === 'busy') return 'text-amber-300';
  if (tone === 'ok') return 'text-emerald-300';
  return 'text-app-text-muted';
}

/** Bar fill per tone, the same three colours. */
export function busyBarClass(tone: BusyTone): string {
  if (tone === 'critical') return 'bg-rose-400';
  if (tone === 'busy') return 'bg-amber-400';
  if (tone === 'ok') return 'bg-emerald-400';
  return 'bg-white/20';
}

/** A CSS colour for surfaces that paint a dot with an inline style (the status
 *  dot sits on the chrome, where the Tailwind text tokens are not the fill). */
export function busyDotColor(tone: BusyTone): string {
  if (tone === 'critical') return 'hsl(0 80% 48%)';
  if (tone === 'busy') return 'hsl(38 90% 48%)';
  if (tone === 'ok') return 'hsl(150 62% 42%)';
  return 'transparent';
}
