/**
 * The three `ps` reads the swap freezer needs, each with an ABSOLUTE path.
 *
 * The server runs under launchd, whose PATH does not carry `/usr/sbin` and, in
 * the wrapper, not even `/bin` reliably: `sysctl` read as `null` for hours on
 * 15/09/2026 for exactly that reason (PR #69), and a freezer whose `ps` silently
 * returns nothing would simply never find a candidate and never say why.
 *
 * Kept out of `process-tree.ts` on purpose: that module's table is a cache for
 * the detector (2 s TTL, `pid,ppid` only), and everything here must be fresh and
 * carry the group and the CPU time the decision is made on.
 */
import { parseProcessTable, type PsRow } from "./agent-tool-children";

async function runPs(args: string[], timeoutMs = 4_000): Promise<string> {
  try {
    const proc = Bun.spawn(["/bin/ps", ...args], { stdout: "pipe", stderr: "ignore" });
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, timeoutMs);
    killer.unref?.();
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(killer);
    return text;
  } catch {
    return "";
  }
}

/** Pid, parent, group, CPU time and argv of every process on the machine. */
export async function readProcessTable(): Promise<PsRow[]> {
  return parseProcessTable(await runPs(["-axo", "pid=,ppid=,pgid=,time=,command=", "-ww"]));
}

/** `pid -> lstart`: the identity that tells a recycled pid from the one we stopped. */
export async function readStartTimes(pids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const text = await runPs(["-o", "pid=,lstart=", "-p", pids.join(",")]);
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) out.set(+m[1]!, m[2]!.trim());
  }
  return out;
}

/** `pid -> stat`: `T` is a stopped process, which is what the post-check reads. */
export async function readProcessStates(pids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const text = await runPs(["-o", "pid=,stat=", "-p", pids.join(",")]);
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (m) out.set(+m[1]!, m[2]!);
  }
  return out;
}
