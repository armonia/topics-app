// Auto-sizing for the dispatch concurrency cap (board "Agent in parallelo").
//
// A dispatched agent is a full headless Claude session in its own git worktree.
// It is mostly I/O-bound (waiting on the API), so we can run more than one per
// core — but each still holds a process, does git work, and bursts CPU while a
// turn streams. We size the cap from stable signals:
//   - CPU cores: the primary budget (I/O-bound → modest oversubscription).
//   - Total RAM: a floor guard for small machines (a ~3 GB/agent budget).
//   - 1-min load average: a LIVE throttle — back off when the box is already busy.
//
// We deliberately IGNORE os.freemem(): on macOS it reports almost nothing "free"
// (the OS keeps reclaimable pages as cache), so it would peg the cap at 1 on a
// perfectly healthy 32 GB machine. Load average is the honest live signal.

import os from "node:os";

// La forma sta in `shared/board.ts` (la legge la UI delle impostazioni board).
export type { DispatchCapacity } from "../../shared/board";
import type { DispatchCapacity } from "../../shared/board";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Absolute ceiling — never auto-recommend more than this regardless of the box. */
const MAX_AUTO_CAP = 8;

export function computeDispatchCapacity(): DispatchCapacity {
  const cores = Math.max(1, os.cpus().length);
  const totalMemGB = os.totalmem() / 1e9;
  const load1 = os.loadavg()[0] ?? 0;

  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // ~3 GB/agent incl. OS headroom — only binding on small-RAM machines.
  const byMem = Math.max(1, Math.floor(totalMemGB / 3));
  // Spare core-units right now (idle → ~cores, saturated → 0); halve into slots.
  const loadFree = clamp(cores - load1, 0, cores);
  const byLoad = Math.max(1, Math.ceil(loadFree / 2));

  const recommended = clamp(Math.min(byCores, byMem, byLoad), 1, MAX_AUTO_CAP);
  const reason =
    `${cores} core → base ${byCores}` +
    (byMem < byCores ? `, limitato dalla RAM (${totalMemGB.toFixed(0)}GB → ${byMem})` : "") +
    (byLoad < Math.min(byCores, byMem) ? `, ridotto per carico (load ${load1.toFixed(1)})` : "");
  return { recommended, cores, totalMemGB: Math.round(totalMemGB * 10) / 10, load1: Math.round(load1 * 100) / 100, reason };
}
