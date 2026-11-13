/**
 * The machine-wide heavy-command broker of THIS server, plus the in-process way
 * for a Topics session to stand in its line.
 *
 * The HTTP routes expose the single broker; the native engine's `bash` tool reaches
 * it over HTTP (see `acquireHeavySlotForCommand`), so `GET /api/heavy-slot`
 * shows native sessions and external harnesses together.
 * Everything here fails open: a broker error means the command just starts.
 */
import os from "node:os";
import { createHeavySlotBroker, type HeavySlotBroker } from "./heavy-slot";
import { acquireHeavySlot, resolveHeavyBase } from "../../scripts/heavy-slot-client";
import { availableMemGB } from "./dispatch-capacity";
import { machineCpuPct } from "../lib/machine-cpu";

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function createDefaultHeavySlotBroker(): HeavySlotBroker {
  return createHeavySlotBroker({
    now: () => Date.now(),
    alive: pidAlive,
    pressure: () => {
      let mem: number | null = null;
      try { mem = availableMemGB(); } catch { /* not measured */ }
      // Off macOS the vm_stat probe is absent: fall back to what the OS calls free.
      mem ??= os.freemem() / 1e9;
      let cpu: number | null = null;
      try { cpu = machineCpuPct(null); } catch { /* not measured */ }
      return { availableMemGB: mem, cpuPct: cpu };
    },
  });
}

let shared: HeavySlotBroker | null = null;
export function sharedHeavySlotBroker(): HeavySlotBroker {
  return (shared ??= createDefaultHeavySlotBroker());
}

export interface CommandLease {
  /** Frees the place. Idempotent, never throws. */
  release: () => void;
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;

function maxWaitFromEnv(): number {
  const raw = process.env.TOPICS_HEAVY_MAX_WAIT_MS;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_MAX_WAIT_MS;
}

/** Where this process reaches the server's line. Cached once found: a turn asks for it on every heavy command. */
let baseFound: string | null = null;
async function serverBase(): Promise<string | null> {
  if (baseFound) return baseFound;
  baseFound = await resolveHeavyBase({ port: process.env.BUN_PORT || process.env.PORT || 3333 });
  return baseFound;
}

/**
 * Waits for a place in the SERVER's line and returns the lease, or `null` when
 * the command should simply run: queue disabled, wait past the deadline, abort,
 * server unreachable, any error.
 *
 * It goes over HTTP even from inside the server, on purpose: a native turn runs
 * detached in `turn-host.ts` by default, and a broker built in that process would
 * be a private line with its own three places, invisible to every other session
 * and to `GET /api/heavy-slot`. The place is tied to this process's pid (the
 * command's pid is not known before it starts): released when the command ends,
 * freed by the broker if this process dies first.
 */
export async function acquireHeavySlotForCommand(opts: {
  label: string;
  signal?: AbortSignal;
  maxWaitMs?: number;
  base?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}): Promise<CommandLease | null> {
  const maxWaitMs = opts.maxWaitMs ?? maxWaitFromEnv();
  if (maxWaitMs <= 0 || opts.signal?.aborted) return null;
  let base: string | null = null;
  try { base = await (opts.base ?? serverBase)(); } catch { return null; }
  if (!base) return null;
  const pending = acquireHeavySlot({ base, label: opts.label, pid: process.pid, maxWaitMs, fetchFn: opts.fetchFn });
  const aborted = new Promise<"aborted">((resolve) => {
    if (opts.signal) opts.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const first = await Promise.race([pending, aborted]);
  if (first === "aborted") {
    // A place granted after the stop would be held for nothing: give it back as soon as it lands.
    void pending.then((lease) => lease?.release());
    return null;
  }
  if (!first) return null;
  return { release: () => { void first.release(); } };
}
