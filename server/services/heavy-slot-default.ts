/**
 * The machine-wide heavy-command broker of THIS server, plus the in-process way
 * for a Topics session to stand in its line.
 *
 * The HTTP routes and the native engine's `bash` tool share one broker, so
 * `GET /api/heavy-slot` shows native sessions and external harnesses together.
 * Everything here fails open: a broker error means the command just starts.
 */
import os from "node:os";
import { createHeavySlotBroker, type HeavySlotBroker } from "./heavy-slot";
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

/** Test seam: swaps the shared broker (null restores the real one). */
export function setSharedHeavySlotBrokerForTest(b: HeavySlotBroker | null): void {
  shared = b;
}

export interface InProcessLease {
  /** Ties the place to the command's process: it is freed when that pid dies. */
  bind: (pid: number) => void;
  release: () => void;
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const POLL_MS = 400;

function maxWaitFromEnv(): number {
  const raw = process.env.TOPICS_HEAVY_MAX_WAIT_MS;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_MAX_WAIT_MS;
}

/**
 * Waits for a place and returns the lease, or `null` when the command should
 * simply run: queue disabled, wait past the deadline, abort, or any error.
 */
export async function acquireHeavySlotInProcess(opts: {
  label: string;
  signal?: AbortSignal;
  broker?: HeavySlotBroker;
  maxWaitMs?: number;
  pollMs?: number;
  onWait?: (message: string) => void;
}): Promise<InProcessLease | null> {
  const maxWaitMs = opts.maxWaitMs ?? maxWaitFromEnv();
  if (maxWaitMs <= 0) return null;
  const pollMs = opts.pollMs ?? POLL_MS;
  let id: string | undefined;
  let broker: HeavySlotBroker;
  try { broker = opts.broker ?? sharedHeavySlotBroker(); } catch { return null; }
  const started = Date.now();
  let said = false;
  try {
    for (;;) {
      const answer = broker.request({ label: opts.label, pid: null, id });
      id = answer.id;
      if (answer.state === "granted") break;
      if (!said) { said = true; opts.onWait?.(`[heavy-slot] in line (${answer.reason})`); }
      if (opts.signal?.aborted || Date.now() - started >= maxWaitMs) {
        broker.release(id);
        return null;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } catch {
    if (id) { try { broker.release(id); } catch { /* fail open */ } }
    return null;
  }
  const leaseId = id!;
  // Until the command has a pid the lease lives by renewal; after `bind` the pid decides.
  const timer = setInterval(() => { try { broker.renew(leaseId); } catch { /* fail open */ } }, 30_000);
  timer.unref?.();
  return {
    bind: (pid) => { try { broker.bind(leaseId, pid); } catch { /* the lease then lives by renewal */ } },
    release: () => { clearInterval(timer); try { broker.release(leaseId); } catch { /* fail open */ } },
  };
}
