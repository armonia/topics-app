/**
 * THE STALL, MEASURED FROM INSIDE THE PROCESS.
 *
 * WHAT THE LOG COULD NOT ANSWER. On 2026-09-07, between 15:41 and 17:11Z, 63
 * minutes out of 90 had a `GET /api/people` or a `GET /api/system/status` over
 * one second (people: median 1,376 ms, max 12,522 ms). In 22 windows of 2.5 to
 * 12.5 seconds the process accepted nothing at all: the sibling routes of the
 * same 60 s tick took their `t0` only when people had finished, so their
 * apparent latency was exactly the duration of people.
 *
 * That shape rules the handler out. `/api/people` is four queries over tables
 * of 3, 3 and 7 rows, with no spawn and nothing awaited before it in the router
 * chain: a handler cannot be slow on that, and it cannot make OTHER handlers
 * late. The thread was not busy, it was STOPPED. The candidate is the machine
 * around it: on the same day this process was 564 MB with 384 MB of it
 * compressed by the kernel, on a machine with 11.3 of 12 GB of swap in use, so
 * a route touched once a minute is cold and its first instruction pays a
 * page-in against an SSD the agent fleet is already saturating.
 *
 * A CANDIDATE IS NOT A CAUSE, and no measurement from outside can promote it:
 * `[HTTP]` lines see the duration and nothing of what happened underneath, and
 * `top` sees a state without knowing which millisecond it belongs to. This
 * sampler answers the one question both are blind to: WHEN the loop stops, what
 * is true of this process at that instant.
 *
 * WHY THESE FOUR NUMBERS. `phys_footprint` and the compressed size say how much
 * of this process the kernel has taken away; `pageins` is the only one of the
 * four that is an EVENT rather than a state, and it is the discriminating one:
 * a stall that comes with a jump in page-ins was the process waiting for the
 * disk, a stall with a flat count was not, and the remedy for the two is not
 * the same. `loadavg` says whether the machine was busy at all, which separates
 * "we were swapped out" from "we were queued behind 12 other runnable threads".
 *
 * COST AT REST: one timer every 500 ms and one struct read per tick, and no
 * line at all while the loop keeps its schedule. It prints only past the
 * threshold, so a quiet server leaves an empty file rather than a baseline to
 * scroll past.
 */
import { loadavg } from "node:os";

/** How often the sampler asks the loop what time it is. */
export const LOOP_LAG_TICK_MS = 500;

/**
 * Below this, nothing is printed.
 *
 * One second is the same bar the audit used to count the bad minutes, and it is
 * far above the normal jitter of a busy but healthy loop (a `Bun.gc(true)` pause
 * measured 1 to 15 ms). A lower bar would fill the log with scheduling noise and
 * bury the 2.5 to 12.5 second windows this exists for.
 */
export const LOOP_LAG_THRESHOLD_MS = 1000;

/** What the process looks like at the instant the loop came back. */
export interface LoopLagSample {
  /** `phys_footprint` in MB: what Activity Monitor calls "Memory". */
  footprintMB: number | null;
  /** Bytes of this task the kernel has compressed, in MB. */
  compressedMB: number | null;
  /** Resident size in MB: what is still in physical pages. */
  residentMB: number | null;
  /** Lifetime count of page faults served from disk. Cumulative, so a delta is what says something. */
  diskFaults: number | null;
  /** One-minute load average of the machine. */
  load1: number;
}

/** The line a stall leaves, or `null` when the loop kept its schedule. */
export function loopLagLine(input: {
  now: Date;
  lagMs: number;
  thresholdMs: number;
  sample: LoopLagSample;
  previousDiskFaults: number | null;
}): string | null {
  const { now, lagMs, thresholdMs, sample, previousDiskFaults } = input;
  if (lagMs <= thresholdMs) return null;
  const delta =
    sample.diskFaults !== null && previousDiskFaults !== null
      ? sample.diskFaults - previousDiskFaults
      : null;
  const mb = (v: number | null) => (v === null ? "?" : String(Math.round(v)));
  return (
    `${now.toISOString()} [LAG] loop stopped ${Math.round(lagMs)}ms` +
    ` footprint=${mb(sample.footprintMB)}MB compressed=${mb(sample.compressedMB)}MB` +
    ` resident=${mb(sample.residentMB)}MB disk-faults=${delta === null ? "?" : `+${delta}`}` +
    ` load1=${sample.load1.toFixed(2)}`
  );
}

/**
 * `proc_pid_rusage` and `task_info` on this process, in one read each.
 *
 * `proc_pid_rusage` is the same call `fleet-usage.ts` already uses for the
 * footprint of any pid; the compressed size is NOT in that struct, so it comes
 * from `task_info(TASK_VM_INFO)`, which only answers for the caller's own task.
 * That is enough here: the process asking is the process that stalls.
 *
 * `null` everywhere off macOS or without FFI. A missing number prints as `?`
 * rather than as a zero that would read like a measurement.
 */
export const readSelfMemory: () => Omit<LoopLagSample, "load1"> = (() => {
  const absent = { footprintMB: null, compressedMB: null, residentMB: null, diskFaults: null };
  if (process.platform !== "darwin") return () => absent;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      task_self_trap: { args: [], returns: FFIType.u32 },
      task_info: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    // rusage_info_v2: 16 bytes of uuid, then `uint64_t` fields. Offsets from the
    // header: ri_pageins is the fifth (16 + 4*8), ri_phys_footprint the eighth
    // (16 + 7*8), the same one `fleet-usage.ts` reads.
    const resourceUsage = new BigUint64Array(64);
    const resourceUsageView = new DataView(resourceUsage.buffer);
    // task_vm_info: resident_size at 16, compressed at 120, both `mach_vm_size_t`.
    const vmInfo = new BigUint64Array(120);
    const vmView = new DataView(vmInfo.buffer);
    const vmCount = new Uint32Array(1);
    const TASK_VM_INFO = 22;
    const MB = 1024 * 1024;
    return () => {
      let footprintMB: number | null = null;
      let diskFaults: number | null = null;
      let residentMB: number | null = null;
      let compressedMB: number | null = null;
      try {
        if (lib.symbols.proc_pid_rusage(process.pid, 2, resourceUsage) === 0) {
          footprintMB = Number(resourceUsageView.getBigUint64(72, true)) / MB;
          diskFaults = Number(resourceUsageView.getBigUint64(48, true));
        }
        vmCount[0] = vmInfo.byteLength / 4;
        if (lib.symbols.task_info(lib.symbols.task_self_trap(), TASK_VM_INFO, ptr(vmInfo), ptr(vmCount)) === 0) {
          residentMB = Number(vmView.getBigUint64(16, true)) / MB;
          compressedMB = Number(vmView.getBigUint64(120, true)) / MB;
        }
      } catch {
        return absent;
      }
      return { footprintMB, compressedMB, residentMB, diskFaults };
    };
  } catch {
    return () => absent;
  }
})();

/**
 * Starts the sampler. Returns the timer so the shutdown path can clear it.
 *
 * The lag is the difference between when a tick FIRED and when it was due:
 * `setInterval` cannot run while the loop is stopped, so a tick that arrives
 * 6 seconds late is a loop that was gone for 6 seconds.
 */
export function startLoopLagSampler(deps: {
  log: (line: string) => void;
  tickMs?: number;
  thresholdMs?: number;
  now?: () => number;
  sample?: () => Omit<LoopLagSample, "load1">;
  load1?: () => number;
}): ReturnType<typeof setInterval> {
  const tickMs = deps.tickMs ?? LOOP_LAG_TICK_MS;
  const thresholdMs = deps.thresholdMs ?? LOOP_LAG_THRESHOLD_MS;
  const now = deps.now ?? Date.now;
  const sample = deps.sample ?? readSelfMemory;
  const load1 = deps.load1 ?? (() => loadavg()[0] ?? 0);
  let due = now() + tickMs;
  let previousDiskFaults: number | null = null;
  const timer = setInterval(() => {
    const at = now();
    const lagMs = at - due;
    due = at + tickMs;
    const taken = { ...sample(), load1: load1() };
    const line = loopLagLine({ now: new Date(at), lagMs, thresholdMs, sample: taken, previousDiskFaults });
    previousDiskFaults = taken.diskFaults;
    if (line !== null) deps.log(line);
  }, tickMs);
  timer.unref?.();
  return timer;
}
