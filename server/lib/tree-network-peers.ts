/**
 * IS ANYBODY OUTSIDE THIS TREE TALKING TO IT?
 *
 * A stopped process does not refuse connections, it stops answering them: a dev
 * server the owner is looking at, or a port another agent's test suite is
 * hitting, would hang instead of failing, and the person on the other side has
 * no way to know why. So before a tree is frozen its own ESTABLISHED sockets are
 * read, and a peer whose pid is OUTSIDE the tree takes it out of the running -
 * the next heaviest candidate is tried instead. A test run whose only client is
 * its own browser (both inside the tree, XPC services included) stays a candidate,
 * which is the case this exists to keep.
 *
 * Run on the CHOSEN victim only, never on every candidate: `lsof` forks, and the
 * machine it forks on is the one already short of memory.
 */
import { captureWithDeadline } from "./bounded-capture";

/** `lsof -nP -FpPn -iTCP -sTCP:ESTABLISHED`: the pids and the peer of each connection. */
export function parseEstablishedPeers(text: string): { pid: number; peer: string }[] {
  const out: { pid: number; peer: string }[] = [];
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)) || 0; continue; }
    if (line.startsWith("n") && pid) out.push({ pid, peer: line.slice(1) });
  }
  return out;
}

/**
 * The local endpoints of the tree, and who is connected to them from outside.
 * Two sides of the same connection appear as two rows: one owned by a pid of the
 * tree, one owned by the peer's pid. A row whose pid is not in the tree and whose
 * peer address is one of the tree's own is an outsider.
 */
export function outsidePeersOf(rows: readonly { pid: number; peer: string }[], tree: ReadonlySet<number>): number[] {
  const mine = new Set<string>();
  for (const r of rows) {
    if (!tree.has(r.pid)) continue;
    const local = r.peer.split("->")[0];
    if (local) mine.add(local);
  }
  const out = new Set<number>();
  for (const r of rows) {
    if (tree.has(r.pid)) continue;
    const remote = r.peer.split("->")[1];
    if (remote && mine.has(remote)) out.add(r.pid);
  }
  return [...out];
}

/**
 * One `lsof` over the established TCP of the machine, or `null` when it did not
 * answer within the deadline.
 *
 * `null` IS NOT AN EMPTY LIST, for the same reason `ps` mute is not an empty
 * `ps` (`process-snapshot.ts`). This answer is the whole evidence behind "nobody
 * outside is talking to this tree", and returning `[]` for a timeout turned a
 * measurement nobody made into a clean bill of health - under sustained swap,
 * which is the only condition in which the freezer ever asks. Measured on this
 * Mac: a real run reads 192 rows, a timed-out one reads 0. The caller skips the
 * candidate instead.
 */
export async function establishedPeers(timeoutMs = 2_000): Promise<{ pid: number; peer: string }[] | null> {
  const capture = await captureWithDeadline(["/usr/sbin/lsof", "-nP", "-FpPn", "-iTCP", "-sTCP:ESTABLISHED"], timeoutMs);
  return capture === null ? null : parseEstablishedPeers(capture.text);
}
