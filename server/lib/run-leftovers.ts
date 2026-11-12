/**
 * Close what a finished card run left behind.
 *
 * WHY (card 8fdd14c8). An agent started twelve `yes` to simulate load, the run
 * ended, and the processes lived on as orphans (ppid 1) for five hours with the
 * card's worktree as cwd: 12 of 16 cores at 100%, CI shards timing out. The
 * tree kill on a human stop only reaches descendants of the CLI pid, and an
 * orphan is not one. What still ties it to the run is its working directory.
 *
 * So: every process whose cwd is inside the run's worktree is SIGTERMed (with
 * its own descendants) and SIGKILLed after the grace, through `killProcessTree`
 * (same identity guard against pid reuse). The session's own CLI is spared: a
 * delivered run may be resumed by a follow-up turn on the same CLI.
 */
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { killProcessTree } from "./process-tree";

export interface Leftover { pid: number; cwd: string; cmd: string }

function inside(dir: string, cwd: string): boolean {
  const rel = relative(dir, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep + sep));
}

/** pid → cwd for every process we can see (Linux /proc, else one `lsof`). */
export function readProcessCwds(): Map<number, string> {
  const out = new Map<number, string>();
  try {
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try { out.set(+name, readlinkSync(`/proc/${name}/cwd`)); } catch { /* gone or not ours */ }
      }
      return out;
    }
    const r = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 10_000 });
    let pid = 0;
    for (const line of (r.stdout ?? "").split("\n")) {
      if (line.startsWith("p")) pid = +line.slice(1);
      else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
    }
  } catch { /* best-effort */ }
  return out;
}

function commandOf(pid: number): string {
  try {
    const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    return (r.stdout ?? "").trim().split("/").pop() || "?";
  } catch { return "?"; }
}

export interface SweepDeps {
  cwds(): Map<number, string>;
  kill(pid: number): Promise<void>;
  describe(pid: number): string;
}

/** Returns the processes it signalled; never throws. */
export async function sweepRunLeftovers(
  worktreePath: string,
  opts: { spare?: Array<number | null | undefined> } = {},
  deps: SweepDeps = { cwds: readProcessCwds, kill: (p) => killProcessTree(p), describe: commandOf },
): Promise<Leftover[]> {
  if (!worktreePath || !isAbsolute(worktreePath)) return [];
  let root = worktreePath;
  try { root = realpathSync(worktreePath); } catch { /* directory already gone: match the literal path */ }
  const spare = new Set<number>([process.pid, process.ppid, ...(opts.spare ?? []).filter((p): p is number => !!p)]);
  const found: Leftover[] = [];
  for (const [pid, cwd] of deps.cwds()) {
    if (spare.has(pid) || !(inside(root, cwd) || inside(worktreePath, cwd))) continue;
    found.push({ pid, cwd, cmd: deps.describe(pid) });
  }
  await Promise.all(found.map((f) => deps.kill(f.pid).catch(() => { /* already dead */ })));
  return found;
}

/** One line for the card thread: how many and which. */
export function describeLeftovers(found: Leftover[]): string {
  const by = new Map<string, number>();
  for (const f of found) by.set(f.cmd, (by.get(f.cmd) ?? 0) + 1);
  const which = [...by].map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(", ");
  return `Fine corsa: chiusi ${found.length} processi rimasti nel worktree (${which}).`;
}
