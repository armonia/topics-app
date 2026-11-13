/**
 * Close what a finished card run left behind.
 *
 * WHY (card 8fdd14c8). An agent started twelve `yes` to simulate load, the run
 * ended, and the processes lived on as orphans (ppid 1) for five hours with the
 * card's worktree as cwd: 12 of 16 cores at 100%, CI shards timing out. The
 * tree kill on a human stop only reaches descendants of the CLI pid, and an
 * orphan is not one. What still ties it to the run is its working directory.
 *
 * So: an ORPHAN is a process whose cwd is inside the run's worktree and that is
 * (or descends from) a process re-parented to init (ppid 1) with its cwd in the
 * worktree. Orphans are SIGTERMed (with their descendants) and SIGKILLed after
 * the grace, through `killProcessTree` (same identity guard against pid reuse).
 *
 * Never touched: anything descending from this server (the delivery checks run
 * in the worktree as its children), from a PTY bridge (a terminal, or a shell a
 * person opened there) or from the session's own CLI (a delivered run may be
 * resumed by a follow-up turn on the same CLI).
 */
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { SPAWN_TIMEOUT, spawnBounded } from "./bounded-spawn";
import { killProcessTree } from "./process-tree";

export interface Leftover { pid: number; cwd: string; cmd: string }

function inside(dir: string, cwd: string): boolean {
  const rel = relative(dir, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep + sep));
}

/** pid → cwd for every process we can see (Linux /proc, else one `lsof`). */
export async function readProcessCwds(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try { out.set(+name, readlinkSync(`/proc/${name}/cwd`)); } catch { /* gone or not ours */ }
      }
      return out;
    }
    const text = await runText(["lsof", "-a", "-d", "cwd", "-Fpn"]);
    let pid = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) pid = +line.slice(1);
      else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
    }
  } catch { /* best-effort */ }
  return out;
}

async function runText(cmd: string[]): Promise<string> {
  const proc = spawnBounded(cmd, { stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

async function commandOf(pid: number): Promise<string> {
  try {
    return (await runText(["ps", "-o", "comm=", "-p", String(pid)])).trim().split("/").pop() || "?";
  } catch { return "?"; }
}

export interface ProcEntry { ppid: number; command: string }

/** pid → parent and command line, from one `ps` snapshot. */
export async function readProcessTable(): Promise<Map<number, ProcEntry>> {
  const out = new Map<number, ProcEntry>();
  try {
    for (const line of (await runText(["ps", "-axo", "pid=,ppid=,command="])).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) out.set(+m[1], { ppid: +m[2], command: m[3] });
    }
  } catch { /* best-effort */ }
  return out;
}

const BRIDGE_COMMAND = /pty-bridge/;

export interface SweepDeps {
  table(): Promise<Map<number, ProcEntry>>;
  cwds(): Promise<Map<number, string>>;
  kill(pid: number): Promise<void>;
  describe(pid: number): Promise<string>;
}

/** Returns the processes it signalled; never throws. */
export async function sweepRunLeftovers(
  worktreePath: string,
  opts: { spare?: Array<number | null | undefined> } = {},
  deps: SweepDeps = { table: readProcessTable, cwds: readProcessCwds, kill: (p) => killProcessTree(p), describe: commandOf },
): Promise<Leftover[]> {
  if (!worktreePath || !isAbsolute(worktreePath)) return [];
  let root = worktreePath;
  try { root = realpathSync(worktreePath); } catch { /* directory already gone: match the literal path */ }
  const protectedPids = new Set<number>([process.pid, process.ppid, ...(opts.spare ?? []).filter((p): p is number => !!p)]);
  const table = await deps.table();
  // Without a process table we cannot tell an orphan from a live check: do nothing.
  if (table.size === 0) return [];
  for (const [pid, e] of table) if (BRIDGE_COMMAND.test(e.command)) protectedPids.add(pid);
  const cwds = await deps.cwds();
  const here = (pid: number) => { const c = cwds.get(pid); return !!c && (inside(root, c) || inside(worktreePath, c)); };
  const found: Leftover[] = [];
  for (const pid of cwds.keys()) {
    if (!here(pid)) continue;
    let orphanRooted = false, shielded = false;
    for (let n = pid, hops = 0; n > 1 && hops < 64; hops++) {
      if (protectedPids.has(n)) { shielded = true; break; }
      const e = table.get(n);
      if (!e) break;
      if (e.ppid <= 1 && here(n)) orphanRooted = true;
      n = e.ppid;
    }
    if (shielded || !orphanRooted) continue;
    found.push({ pid, cwd: cwds.get(pid)!, cmd: await deps.describe(pid) });
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
