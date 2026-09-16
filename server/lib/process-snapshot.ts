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
import { captureWithDeadline } from "./bounded-capture";

/**
 * `null` MEANS `ps` DID NOT ANSWER, and it is never the same as an empty answer.
 *
 * `ps -p <dead pid>` legitimately prints nothing (exit 1, empty stderr), so the
 * exit code cannot tell the two apart. What can is the only way this call fails
 * in production: a spawn that throws, or the 4 s timeout firing - which is the
 * Mac in sustained swap, the exact condition the freezer runs in. A caller that
 * read `""` as "that pid is gone" would SIGSTOP a tree while recording an empty
 * identity for it, and no thaw could ever match it again.
 *
 * The 4 s are a deadline on the ANSWER (`bounded-capture.ts`), which is the only
 * shape that holds the promise this file's header makes: a `ps` that hangs used
 * to leave the freezer's beat awaiting it for ever, and with the beat the ten
 * minute thaw cap.
 */
async function runPs(args: string[], timeoutMs = 4_000): Promise<string | null> {
  const capture = await captureWithDeadline(["/bin/ps", ...args], timeoutMs);
  return capture === null ? null : capture.text;
}

/** Pid, parent, group, CPU time and argv of every process, or `null` if `ps` was mute. */
export async function readProcessTable(): Promise<PsRow[] | null> {
  const text = await runPs(["-axo", "pid=,ppid=,pgid=,time=,command=", "-ww"]);
  return text === null ? null : parseProcessTable(text);
}

/** `pid -> lstart`: the identity that tells a recycled pid from the one we stopped. */
export async function readStartTimes(pids: readonly number[]): Promise<Map<number, string> | null> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const text = await runPs(["-o", "pid=,lstart=", "-p", pids.join(",")]);
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) out.set(+m[1]!, m[2]!.trim());
  }
  return out;
}

/** `pid -> stat`: `T` is a stopped process, which is what the post-check reads. */
export async function readProcessStates(pids: readonly number[]): Promise<Map<number, string> | null> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const text = await runPs(["-o", "pid=,stat=", "-p", pids.join(",")]);
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (m) out.set(+m[1]!, m[2]!);
  }
  return out;
}
