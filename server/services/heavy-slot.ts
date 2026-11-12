/**
 * THE MACHINE-WIDE SLOT FOR HEAVY COMMANDS, served by Topics.
 *
 * Every harness on the machine (Topics agents, the Claude desktop app, Codex,
 * other CLIs) asks here before a heavy command (tsc, a targeted `bun test`,
 * cargo, vitest, ffmpeg) and releases when it ends. The decision is taken on
 * what the machine can bear, memory first and CPU second, never on how many
 * agents exist: the sessions themselves cost almost nothing, their gates do.
 *
 * WHY IT IS NOT `scripts/slot.ts`. That one counts files in a directory and
 * admits `cores/4` runs whatever the memory says, so a Mac with 31 of 32 GB used
 * still admitted a typecheck that then ran 30 minutes in swap. Here a request is
 * admitted when a slot is free AND the pressure reader says there is room.
 *
 * PROGRESS IS GUARANTEED. With nothing held, the first request is admitted
 * unless memory is critically low, and the client gives up waiting after a
 * deadline (fail-open, see `scripts/heavy-slot.ts`): a queue that can block
 * work forever is worse than no queue.
 *
 * A HOLDER NEVER LEAKS. A lease is dropped when its process is dead, when it
 * stopped renewing, or at the wall-clock cap. A waiter that stopped polling is
 * dropped from the line, so a killed harness cannot hold the queue.
 */

export interface HeavyPressure {
  /** Gigabytes really available, or null when not measured (never blocks). */
  availableMemGB: number | null;
  /** Machine-wide busy percentage, or null when not measured (never blocks). */
  cpuPct: number | null;
}

export interface HeavySlotConfig {
  /** Hard ceiling on concurrent holders. */
  maxSlots: number;
  /** A second holder (and more) needs at least this much memory available. */
  memFloorGB: number;
  /** Even the first holder waits below this (the machine is swapping). */
  criticalMemGB: number;
  /** Extra holders are not admitted above this machine-wide CPU percentage. */
  cpuCeilingPct: number;
  /** A lease not renewed for this long is gone. */
  leaseTtlMs: number;
  /** A lease older than this is gone whatever it says. */
  maxRunMs: number;
  /** A waiter not polled for this long is gone. */
  waiterTtlMs: number;
}

export const HEAVY_SLOT_DEFAULTS: HeavySlotConfig = {
  maxSlots: 3,
  memFloorGB: 6,
  criticalMemGB: 1.5,
  cpuCeilingPct: 85,
  leaseTtlMs: 90_000,
  maxRunMs: 60 * 60_000,
  waiterTtlMs: 45_000,
};

export interface HeavySlotDeps {
  now: () => number;
  pressure: () => HeavyPressure;
  alive: (pid: number) => boolean;
}

interface Lease { id: string; label: string; pid: number | null; since: number; renewed: number }
interface Waiter { id: string; label: string; pid: number | null; since: number; polled: number }

export type HeavySlotAnswer =
  | { state: "granted"; id: string; waitedMs: number }
  | { state: "waiting"; id: string; position: number; reason: string };

export function admits(held: number, p: HeavyPressure, cfg: HeavySlotConfig): { ok: boolean; reason: string } {
  if (held >= cfg.maxSlots) return { ok: false, reason: `${held} heavy commands already running` };
  if (p.availableMemGB != null && p.availableMemGB < cfg.criticalMemGB) {
    return { ok: false, reason: `memory critical (${p.availableMemGB.toFixed(1)} GB available)` };
  }
  if (held === 0) return { ok: true, reason: "idle" };
  if (p.availableMemGB != null && p.availableMemGB < cfg.memFloorGB) {
    return { ok: false, reason: `memory low (${p.availableMemGB.toFixed(1)} GB available)` };
  }
  if (p.cpuPct != null && p.cpuPct > cfg.cpuCeilingPct) {
    return { ok: false, reason: `cpu busy (${Math.round(p.cpuPct)}%)` };
  }
  return { ok: true, reason: "room" };
}

export interface HeavySlotBroker {
  /** Ask for a place. Call again with the returned id to keep waiting. */
  request(input: { label: string; pid?: number | null; id?: string }): HeavySlotAnswer;
  /** Keep a lease alive. False when it is unknown (already reaped). */
  renew(id: string): boolean;
  /** Free a lease or leave the line. Idempotent. */
  release(id: string): boolean;
  status(): { held: Lease[]; waiting: Waiter[]; config: HeavySlotConfig };
}

export function createHeavySlotBroker(deps: HeavySlotDeps, overrides: Partial<HeavySlotConfig> = {}): HeavySlotBroker {
  const cfg: HeavySlotConfig = { ...HEAVY_SLOT_DEFAULTS, ...overrides };
  const held = new Map<string, Lease>();
  const line: Waiter[] = [];
  // Waiters admitted by someone else's drain, read once by their next poll.
  const granted = new Map<string, number>();
  let seq = 0;

  function reap(): void {
    const t = deps.now();
    for (const [id, l] of held) {
      const dead = l.pid != null && !deps.alive(l.pid);
      if (dead || t - l.renewed > cfg.leaseTtlMs || t - l.since > cfg.maxRunMs) held.delete(id);
    }
    for (let i = line.length - 1; i >= 0; i--) {
      const w = line[i]!;
      const dead = w.pid != null && !deps.alive(w.pid);
      if (dead || t - w.polled > cfg.waiterTtlMs) line.splice(i, 1);
    }
  }

  /** Admit from the head of the line while the verdict says yes (FIFO). */
  function drain(): void {
    while (line.length > 0) {
      if (!admits(held.size, deps.pressure(), cfg).ok) return;
      const w = line.shift()!;
      const t = deps.now();
      held.set(w.id, { id: w.id, label: w.label, pid: w.pid, since: t, renewed: t });
      granted.set(w.id, t - w.since);
    }
  }

  return {
    request({ label, pid = null, id }) {
      reap();
      const t = deps.now();
      if (id && granted.has(id)) {
        const waitedMs = granted.get(id)!;
        granted.delete(id);
        const l = held.get(id);
        if (l) l.renewed = t;
        return { state: "granted", id, waitedMs };
      }
      if (id && held.has(id)) {
        held.get(id)!.renewed = t;
        return { state: "granted", id, waitedMs: 0 };
      }
      let w = id ? line.find((x) => x.id === id) : undefined;
      if (!w) {
        w = { id: id ?? `h${t.toString(36)}${(seq++).toString(36)}`, label, pid, since: t, polled: t };
        line.push(w);
      }
      w.polled = t;
      drain();
      if (granted.has(w.id)) {
        const waitedMs = granted.get(w.id)!;
        granted.delete(w.id);
        return { state: "granted", id: w.id, waitedMs };
      }
      const position = line.indexOf(w) + 1;
      const head = admits(held.size, deps.pressure(), cfg);
      return { state: "waiting", id: w.id, position, reason: position > 1 ? `${position - 1} ahead in line` : head.reason };
    },
    renew(id) {
      const l = held.get(id);
      if (!l) return false;
      l.renewed = deps.now();
      return true;
    },
    release(id) {
      granted.delete(id);
      const i = line.findIndex((x) => x.id === id);
      if (i >= 0) line.splice(i, 1);
      const had = held.delete(id);
      reap();
      drain();
      return had || i >= 0;
    },
    status() {
      reap();
      return { held: [...held.values()], waiting: [...line], config: cfg };
    },
  };
}
